/**
 * O orquestrador: uma AWS Lambda durable function que conduz uma solicitacao
 * de compra do pedido ate o pagamento, passando por aprovacao humana.
 *
 *   solicitacao ──► roteamento por valor ──► aprovacao(oes) ──► pagamento
 *                    (deterministico,          (waitForCallback,
 *                     sem I/O)                   com escalonamento
 *                                                 e possivel paralelismo)
 *
 * Este e o segundo laboratorio do repositorio. O primeiro (app/, fluxo de
 * boleto) e sempre linear: emissao, um unico callback, baixa, extrato em
 * paralelo, conciliacao. Este aqui foi desenhado para cobrir o que aquele
 * NAO cobre:
 *
 * 1. Roteamento condicional. `decidirRota` decide, so olhando o valor, se a
 *    solicitacao pula aprovacao, passa so pelo gestor, ou passa por gestor E
 *    financeiro. E uma funcao pura — pode rodar fora de um step porque o
 *    valor de entrada ja veio de um checkpoint anterior (o payload da
 *    invocacao), entao o resultado e sempre o mesmo em qualquer replay.
 *
 * 2. Escalonamento: dois `waitForCallback` em cadeia. Se o gestor nao decide
 *    no prazo, o SDK lanca `CallbackTimeoutError` e o codigo abre um SEGUNDO
 *    callback, agora para a diretoria, com prazo proprio. So depois dos dois
 *    prazos vencidos a solicitacao expira.
 *
 * 3. `ctx.parallel` com `waitForCallback` DENTRO de cada ramo — nao com
 *    steps, como no app de boleto. Gestor e financeiro decidem ao mesmo
 *    tempo, cada um no seu proprio callback, cada um com seu proprio
 *    escalonamento.
 *
 * 4. As duas metades da API de callback, usadas pelo motivo certo:
 *    `SendDurableExecutionCallbackSuccess` tambem para REJEICAO (rejeitar e
 *    uma decisao de negocio valida, nao uma falha) e
 *    `SendDurableExecutionCallbackFailure` para quando o financeiro reporta
 *    indisponibilidade tecnica de verdade — o unico caso em que Failure e
 *    semanticamente correto.
 *
 * 5. A mesma licao central do app de boleto, reaplicada: o step que executa
 *    o pagamento usa `AtMostOncePerRetry`, e so fica seguro de verdade porque
 *    a politica de retry recusa `StepInterruptedError` (veja RETRY_PAGAMENTO
 *    abaixo). Reaproveitar essa licao aqui, num contexto novo, e proposital —
 *    e a demonstracao de que ela nao e um truque do dominio de boleto, e sim
 *    do proprio recurso.
 */
import {
  JitterStrategy,
  StepSemantics,
  createRetryStrategy,
  withDurableExecution,
} from "@aws/durable-execution-sdk-js";
import { MODOS_CAOS, aplicarCaos, foiInterrompido } from "./shared/chaos.mjs";
import {
  PAPEIS,
  STAGE,
  STATUS,
  capitalizar,
  comprovantePagamento,
  decidirRota,
  dormir,
  formatarBRL,
} from "./shared/domain.mjs";
import * as store from "./shared/store.mjs";

const LIMITE_AUTOMATICO_CENTAVOS = Number(process.env.LIMITE_AUTOMATICO_CENTAVOS ?? "30000"); // R$ 300
const LIMITE_FINANCEIRO_CENTAVOS = Number(process.env.LIMITE_FINANCEIRO_CENTAVOS ?? "500000"); // R$ 5.000

const PRAZO_GESTOR_MINUTOS = Number(process.env.PRAZO_GESTOR_MINUTOS ?? "1440"); // 24h
const PRAZO_DIRETORIA_MINUTOS = Number(process.env.PRAZO_DIRETORIA_MINUTOS ?? "2880"); // 48h
const PRAZO_FINANCEIRO_MINUTOS = Number(process.env.PRAZO_FINANCEIRO_MINUTOS ?? "1440"); // 24h

/** Segundos de pausa entre etapas, so para dar tempo de acompanhar o board. */
const RITMO_SEGUNDOS = Number(process.env.RITMO_DEMO_SEGUNDOS ?? "6");

/**
 * Pausa entre etapas usando `ctx.wait` — SUSPENDE a execucao, nao custa
 * compute. Ver a explicacao completa em app/backend/src/orchestrator.mjs,
 * onde essa distincao (wait vs. sleep dentro de um step) e o foco central.
 */
const respirar = (ctx, nome) =>
  RITMO_SEGUNDOS > 0 ? ctx.wait(nome, { seconds: RITMO_SEGUNDOS }) : Promise.resolve();

/** 4 tentativas, 3s -> 6s -> 12s, com jitter pela metade. */
const retryTransitorio = createRetryStrategy({
  maxAttempts: 4,
  initialDelay: { seconds: 3 },
  maxDelay: { seconds: 20 },
  backoffRate: 2,
  jitter: JitterStrategy.HALF,
});

/**
 * `AtMostOncePerRetry` sozinho NAO impede que o step rode duas vezes — ele
 * so promete no maximo uma execucao POR TENTATIVA. Quando a invocacao morre
 * no meio do step, o SDK monta um `StepInterruptedError` e pergunta a esta
 * politica se deve tentar de novo. Recusar a interrupcao e o que fecha a
 * garantia; aceitar (como a `retryTransitorio` sozinha faria) reexecuta o
 * step e aplica o pagamento em duplicidade.
 */
const RETRY_PAGAMENTO = (erro, tentativas) => {
  if (erro?.name === "StepInterruptedError") return { shouldRetry: false };
  return retryTransitorio(erro, tentativas);
};

const ehTimeout = (erro) => erro?.name === "CallbackTimeoutError";
const ehFalhaExterna = (erro) => erro?.name === "CallbackExternalError";

/**
 * Abre um `waitForCallback` para um papel (gestor/diretoria/financeiro),
 * registra o callbackId no DynamoDB para a API poder resolve-lo depois, e
 * grava a decisao quando ela chegar.
 *
 * O resultado do callback e sempre `Success` com um payload estruturado
 * `{ decisao: "aprovado" | "rejeitado", aprovador, comentario }` — mesmo
 * quando a decisao e "rejeitado". Rejeitar e um resultado de negocio valido,
 * nao uma falha do lado de quem respondeu; usar `CallbackFailure` para isso
 * seria semanticamente errado. `CallbackFailure` fica reservado para quando
 * o RESPONDENTE nao consegue processar (ver `fluxoAprovacaoFinanceiro`).
 */
async function pedirDecisao(ctx, solicitacaoId, papel, prazoMinutos) {
  const Papel = capitalizar(papel);
  const statusPorPapel = {
    [PAPEIS.GESTOR]: STATUS.AGUARDANDO_GESTOR,
    [PAPEIS.DIRETORIA]: STATUS.AGUARDANDO_DIRETORIA,
    [PAPEIS.FINANCEIRO]: STATUS.AGUARDANDO_FINANCEIRO,
  };

  const resultadoBruto = await ctx.waitForCallback(
    `aguardando-${papel}`,
    async (callbackId, step) => {
      await store.avancar(solicitacaoId, {
        status: statusPorPapel[papel],
        stage: STAGE.APROVACAO,
        message: `Aguardando decisao de ${papel}. Execucao suspensa: zero compute ate a decisao chegar.`,
        patch: { [`callbackId${Papel}`]: callbackId },
        data: { callbackId, papel, prazoMinutos },
      });
      step.logger.info("callback registrado, suspendendo execucao", { papel, callbackId });
    },
    { timeout: { minutes: prazoMinutos } },
  );

  const decisao = JSON.parse(resultadoBruto);
  const aprovado = decisao.decisao === "aprovado";

  await ctx.step(`registrar-decisao-${papel}`, async (step) => {
    await store.avancar(solicitacaoId, {
      stage: STAGE.APROVACAO,
      message: `${Papel} ${aprovado ? "aprovou" : "rejeitou"} a solicitacao${decisao.comentario ? `: ${decisao.comentario}` : ""}`,
      patch: {
        [`decisao${Papel}`]: decisao.decisao,
        [`aprovador${Papel}`]: decisao.aprovador,
        [`comentario${Papel}`]: decisao.comentario,
      },
    });
    step.logger.info("decisao registrada", { papel, decisao: decisao.decisao, aprovador: decisao.aprovador });
  });

  return { aprovado, aprovador: decisao.aprovador, comentario: decisao.comentario };
}

/**
 * Gestor decide; se nao responder no prazo, escala para a diretoria; se a
 * diretoria tambem nao responder, a solicitacao expira. Dois `waitForCallback`
 * em cadeia, cada um com seu proprio prazo.
 */
async function fluxoAprovacaoComEscalonamento(ctx, solicitacaoId) {
  try {
    return await pedirDecisao(ctx, solicitacaoId, PAPEIS.GESTOR, PRAZO_GESTOR_MINUTOS);
  } catch (erro) {
    if (!ehTimeout(erro)) throw erro;

    await ctx.step("escalar-diretoria", async (step) => {
      await store.avancar(solicitacaoId, {
        stage: STAGE.APROVACAO,
        level: "WARN",
        message: `Gestor nao respondeu em ${PRAZO_GESTOR_MINUTOS} min. Escalado para a diretoria.`,
      });
      step.logger.warn("escalando para diretoria", { solicitacaoId });
    });

    try {
      return await pedirDecisao(ctx, solicitacaoId, PAPEIS.DIRETORIA, PRAZO_DIRETORIA_MINUTOS);
    } catch (erro2) {
      if (!ehTimeout(erro2)) throw erro2;
      await ctx.step("expirar-aprovacao-gestor", async () => {
        await store.avancar(solicitacaoId, {
          level: "WARN",
          message: `Diretoria tambem nao respondeu em ${PRAZO_DIRETORIA_MINUTOS} min.`,
        });
      });
      return { aprovado: false, motivo: "expirado" };
    }
  }
}

/**
 * Financeiro decide, sem escalonamento (fica mais simples de propósito, para
 * nao duplicar a licao de cadeia). Alem do timeout, este ramo trata um erro
 * que o outro nunca ve: `CallbackExternalError`, disparado quando o
 * financeiro usa `SendDurableExecutionCallbackFailure` para reportar que nao
 * consegue processar a decisao agora — uma falha tecnica de verdade, nao uma
 * rejeicao.
 */
async function fluxoAprovacaoFinanceiro(ctx, solicitacaoId) {
  try {
    return await pedirDecisao(ctx, solicitacaoId, PAPEIS.FINANCEIRO, PRAZO_FINANCEIRO_MINUTOS);
  } catch (erro) {
    if (ehTimeout(erro)) {
      await ctx.step("expirar-aprovacao-financeiro", async () => {
        await store.avancar(solicitacaoId, {
          level: "WARN",
          message: `Financeiro nao respondeu em ${PRAZO_FINANCEIRO_MINUTOS} min.`,
        });
      });
      return { aprovado: false, motivo: "expirado" };
    }
    if (ehFalhaExterna(erro)) {
      await ctx.step("registrar-falha-financeiro", async (step) => {
        await store.avancar(solicitacaoId, {
          level: "ERROR",
          message: `Financeiro reportou indisponibilidade tecnica: ${erro.message}`,
        });
        step.logger.warn("CallbackExternalError recebido do financeiro", { solicitacaoId });
      });
      return { aprovado: false, motivo: "falha-tecnica" };
    }
    throw erro;
  }
}

async function fluxoDeAprovacao(evento, ctx) {
  const { solicitacaoId, valorCentavos } = evento;
  ctx.logger.info("fluxo de aprovacao iniciado", { solicitacaoId, valorCentavos });

  // ───────────────────────── 1. Solicitacao ─────────────────────────
  await ctx.step("registrar-solicitacao", async (step) => {
    await store.avancar(solicitacaoId, {
      status: STATUS.SOLICITADA,
      stage: STAGE.SOLICITACAO,
      message: "Solicitacao registrada, avaliando rota de aprovacao",
    });
    step.logger.info("solicitacao registrada", { solicitacaoId });
  });

  // Roteamento: funcao pura, sem I/O — seguro fora de um step porque
  // `valorCentavos` ja veio do payload da invocacao (um checkpoint em si).
  const rota = decidirRota(valorCentavos, LIMITE_AUTOMATICO_CENTAVOS, LIMITE_FINANCEIRO_CENTAVOS);

  await ctx.step("registrar-rota", async () => {
    await store.avancar(solicitacaoId, {
      stage: STAGE.APROVACAO,
      message: rota.autoAprovar
        ? `Valor abaixo de ${formatarBRL(LIMITE_AUTOMATICO_CENTAVOS)}: aprovacao automatica`
        : rota.precisaFinanceiro
          ? `Valor acima de ${formatarBRL(LIMITE_FINANCEIRO_CENTAVOS)}: exige gestor e financeiro em paralelo`
          : "Exige aprovacao do gestor",
      patch: { precisaFinanceiro: rota.precisaFinanceiro },
    });
  });

  // ───────────────────────── 2. Aprovacao(oes) ─────────────────────────
  if (!rota.autoAprovar) {
    let decisaoFinal;

    if (rota.precisaFinanceiro) {
      // Gestor e financeiro decidem ao mesmo tempo — dois `waitForCallback`
      // independentes, um por ramo. Se um ramo cair (crash, erro nao
      // tratado), o outro continua normalmente: cada branch de um
      // `ctx.parallel` e um contexto proprio.
      const resultado = await ctx.parallel("aprovacoes", [
        { name: "aprovacao-gestor", func: (filho) => fluxoAprovacaoComEscalonamento(filho, solicitacaoId) },
        { name: "aprovacao-financeiro", func: (filho) => fluxoAprovacaoFinanceiro(filho, solicitacaoId) },
      ]);

      // Os ramos sao identificados por `index`, nao pela posicao no array
      // `all`: a ordem de conclusao nao e a ordem de declaracao.
      const doGestor = resultado.all.find((item) => item.index === 0)?.result;
      const doFinanceiro = resultado.all.find((item) => item.index === 1)?.result;

      if (doGestor?.aprovado && doFinanceiro?.aprovado) {
        decisaoFinal = { aprovado: true };
      } else if (!doGestor?.aprovado) {
        decisaoFinal = { aprovado: false, motivo: doGestor?.motivo ?? "rejeitado", origem: "gestor" };
      } else {
        decisaoFinal = { aprovado: false, motivo: doFinanceiro?.motivo ?? "rejeitado", origem: "financeiro" };
      }
    } else {
      const resultado = await fluxoAprovacaoComEscalonamento(ctx, solicitacaoId);
      decisaoFinal = resultado.aprovado
        ? { aprovado: true }
        : { aprovado: false, motivo: resultado.motivo ?? "rejeitado", origem: "gestor/diretoria" };
    }

    if (!decisaoFinal.aprovado) {
      const expirou = decisaoFinal.motivo === "expirado";
      await ctx.step(expirou ? "expirar-solicitacao" : "rejeitar-solicitacao", async () => {
        await store.avancar(solicitacaoId, {
          status: expirou ? STATUS.EXPIRADA : STATUS.REJEITADA,
          stage: STAGE.FIM,
          level: "WARN",
          message: expirou
            ? `Solicitacao expirada: ${decisaoFinal.origem} nao decidiu dentro do prazo`
            : `Solicitacao rejeitada por ${decisaoFinal.origem}`,
        });
      });
      return { solicitacaoId, status: expirou ? STATUS.EXPIRADA : STATUS.REJEITADA, motivo: decisaoFinal.motivo };
    }

    await ctx.step("aprovar", async () => {
      await store.avancar(solicitacaoId, {
        status: STATUS.APROVADA,
        stage: STAGE.APROVACAO,
        message: "Solicitacao aprovada, preparando execucao do pagamento",
      });
    });
  }

  // ───────────────────────── 3. Pagamento ─────────────────────────
  await respirar(ctx, "ritmo-antes-do-pagamento");

  const executarPagamento = async (step) => {
    const inicio = Date.now();
    await store.avancar(solicitacaoId, {
      status: STATUS.EXECUTANDO_PAGAMENTO,
      stage: STAGE.EXECUCAO,
      message: step.attempt === 1 ? "Executando pagamento" : `Executando pagamento (tentativa ${step.attempt})`,
      attempt: step.attempt,
    });

    await aplicarCaos(solicitacaoId, MODOS_CAOS.FALHAR_PAGAMENTO, step.logger);
    // Derrubada ANTES do efeito: a conferencia vai constatar que nada foi
    // aplicado e refazer com seguranca.
    await aplicarCaos(solicitacaoId, MODOS_CAOS.DERRUBAR_ANTES_PAGAMENTO, step.logger);
    await dormir(1200);

    // ─── o efeito colateral irreversivel ───
    const comprovante = comprovantePagamento(solicitacaoId);
    await store.avancar(solicitacaoId, {
      status: STATUS.PAGA,
      stage: STAGE.EXECUCAO,
      message: `Pagamento executado, comprovante ${comprovante}`,
      attempt: step.attempt,
      durationMs: Date.now() - inicio,
      patch: { comprovante, executadoEm: new Date().toISOString() },
    });

    // Derrubada DEPOIS do efeito e antes do checkpoint: o caso perigoso. O
    // dinheiro ja saiu, o durable nao sabe. A conferencia acha o comprovante
    // e nao refaz nada.
    await aplicarCaos(solicitacaoId, MODOS_CAOS.DERRUBAR_APOS_PAGAMENTO, step.logger);
    return { comprovante };
  };

  let pagamento;
  try {
    pagamento = await ctx.step("executar-pagamento", executarPagamento, {
      semantics: StepSemantics.AtMostOncePerRetry,
      retryStrategy: RETRY_PAGAMENTO,
    });
  } catch (erro) {
    if (!foiInterrompido(erro)) throw erro;

    pagamento = await ctx.step("conferir-pagamento", async (step) => {
      step.logger.warn("pagamento interrompido sem checkpoint, conferindo estado real", { solicitacaoId });
      const atual = await store.obterSolicitacao(solicitacaoId);
      if (atual?.comprovante) {
        await store.avancar(solicitacaoId, {
          status: STATUS.PAGA,
          stage: STAGE.EXECUCAO,
          level: "WARN",
          message: `Invocacao caiu no meio do pagamento, mas a conferencia achou o comprovante ${atual.comprovante}. Nada foi refeito.`,
          data: { comprovante: atual.comprovante, origem: "conferencia" },
        });
        return { comprovante: atual.comprovante, conferido: true };
      }

      await store.avancar(solicitacaoId, {
        stage: STAGE.EXECUCAO,
        level: "WARN",
        message: "Invocacao caiu antes de executar o pagamento. Conferencia confirmou que nada foi aplicado, refazendo.",
      });
      const refeito = await executarPagamento(step);
      return { ...refeito, conferido: true };
    });
  }

  // ─────────────────────────── 4. Fim ───────────────────────────
  await ctx.step("notificar-solicitante", async () => {
    await store.avancar(solicitacaoId, {
      stage: STAGE.FIM,
      message: `Solicitante notificado: pagamento realizado, comprovante ${pagamento.comprovante}`,
    });
  });

  ctx.logger.info("fluxo de aprovacao concluido", { solicitacaoId, comprovante: pagamento.comprovante });
  return { solicitacaoId, status: STATUS.PAGA, comprovante: pagamento.comprovante };
}

/**
 * Registra a falha na solicitacao e propaga o erro: a execucao durable
 * precisa terminar em FAILED, senao a API de durable executions mentiria
 * sobre o que aconteceu.
 */
async function comRegistroDeFalha(evento, ctx) {
  try {
    return await fluxoDeAprovacao(evento, ctx);
  } catch (erro) {
    ctx.logger.error("fluxo de aprovacao falhou", { solicitacaoId: evento?.solicitacaoId, erro: erro.message });
    try {
      await ctx.step("registrar-falha", async () => {
        await store.avancar(evento.solicitacaoId, {
          status: STATUS.FALHOU,
          level: "ERROR",
          message: `Workflow encerrado com erro: ${erro.message}`,
          patch: { erro: erro.message },
        });
      });
    } catch (falhaAoRegistrar) {
      // Registrar o desfecho e melhor-esforco. O erro que importa e o original.
      ctx.logger.error("nao foi possivel registrar a falha", { erro: falhaAoRegistrar.message });
    }
    throw erro;
  }
}

export const handler = withDurableExecution(comRegistroDeFalha);
