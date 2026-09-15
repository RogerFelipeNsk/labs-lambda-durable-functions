/**
 * O orquestrador: uma AWS Lambda durable function que conduz o ciclo de vida
 * de uma cobranca do inicio ao fim.
 *
 *   emissao ──► aguarda pagamento ──► baixa ──► extrato ──► conciliacao
 *                (suspensa, sem         (efeito     (em paralelo com
 *                 custo de compute)      financeiro)  a notificacao)
 *
 * O que torna isso uma durable function e nao um handler comum:
 *
 * 1. `ctx.waitForCallback` suspende a execucao ate o webhook do banco chegar.
 *    Podem se passar tres dias. Nenhum worker fica de pe, nenhuma concorrencia
 *    fica reservada, e nada e cobrado nesse intervalo.
 *
 * 2. Cada `ctx.step` vira um checkpoint. Se a invocacao morrer, a Lambda e
 *    reinvocada, este arquivo roda de novo do topo, e os steps ja concluidos
 *    NAO executam de novo — o SDK devolve o resultado gravado. Por isso o
 *    codigo fora dos steps precisa ser deterministico.
 *
 * 3. A baixa usa `AtMostOncePerRetry` MAIS uma politica de retry que recusa
 *    interrupcoes (veja RETRY_BAIXA abaixo — a semantica sozinha nao basta).
 *    Se a invocacao morrer depois do efeito colateral mas antes do checkpoint,
 *    o step nao e repetido: o fluxo recebe `StepInterruptedError`, que nao
 *    significa "falhou" e sim "nao sei se deu certo". A resposta correta e
 *    conferir, nao repetir. Comparar isso com o extrato
 *    (`AtLeastOncePerRetry`, idempotente) e a licao central deste laboratorio.
 */
import {
  JitterStrategy,
  StepSemantics,
  createRetryStrategy,
  withDurableExecution,
} from "@aws/durable-execution-sdk-js";
import { MODOS_CAOS, aplicarCaos, consumirCaos, foiInterrompido } from "./shared/chaos.mjs";
import {
  STAGE,
  STATUS,
  TARIFA_LIQUIDACAO_CENTAVOS,
  comprovanteBaixa,
  dadosBancarios,
  dormir,
  formatarBRL,
  idConciliacao,
  idExtrato,
} from "./shared/domain.mjs";
import * as store from "./shared/store.mjs";

/** 4 tentativas, 3s -> 6s -> 12s, com jitter pela metade para nao sincronizar
 *  retentativas de varios boletos ao mesmo tempo. */
const retryTransitorio = createRetryStrategy({
  maxAttempts: 4,
  initialDelay: { seconds: 3 },
  maxDelay: { seconds: 20 },
  backoffRate: 2,
  jitter: JitterStrategy.HALF,
});

/**
 * Politica de retry da baixa.
 *
 * ATENCAO, e aqui que quase todo mundo erra: `AtMostOncePerRetry` sozinho NAO
 * impede que um step com efeito colateral rode duas vezes. O nome e literal —
 * "no maximo uma vez POR TENTATIVA". Quando a invocacao morre no meio do step,
 * o SDK monta um `StepInterruptedError` e **pergunta para esta funcao** se deve
 * tentar de novo. Se a resposta for sim, o step executa outra vez, agora como
 * tentativa 2, e o efeito colateral acontece em duplicidade.
 *
 * Quem transforma a garantia em "nunca repito, eu te aviso" e esta linha: uma
 * interrupcao nao e retentavel. Ai o SDK lanca `StepError` com
 * `cause.name === "StepInterruptedError"` e o fluxo pode CONFERIR o que
 * aconteceu de verdade, em vez de repetir no escuro.
 *
 * Falhas transitorias comuns continuam sendo retentadas normalmente.
 */
const RETRY_BAIXA = (erro, tentativas) => {
  if (erro?.name === "StepInterruptedError") return { shouldRetry: false };
  return retryTransitorio(erro, tentativas);
};

/** O extrato e idempotente e barato de refazer: pode ser mais agressivo. */
const RETRY_EXTRATO = createRetryStrategy({
  maxAttempts: 5,
  initialDelay: { seconds: 2 },
  maxDelay: { seconds: 15 },
  backoffRate: 2,
});

const HORAS_PARA_PAGAR = Number(process.env.TIMEOUT_PAGAMENTO_HORAS ?? "72");

/** Segundos de pausa entre as etapas, so para dar tempo de acompanhar o board. */
const RITMO_SEGUNDOS = Number(process.env.RITMO_DEMO_SEGUNDOS ?? "6");

/**
 * Pausa entre etapas, para a demonstracao ficar legivel.
 *
 * Usa `ctx.wait`, e nao um setTimeout dentro de um step — e essa a diferenca
 * que importa: `ctx.wait` SUSPENDE a execucao. A invocacao termina, o
 * container morre, e a Lambda so e chamada de novo quando o prazo vence.
 * Aumentar este ritmo nao custa compute nenhum. Se fosse `dormir()`, cada
 * segundo aqui seria cobrado como tempo de execucao.
 *
 * O valor vem do ambiente, que e imutavel por versao publicada — entao a
 * sequencia de operacoes e a mesma em todo replay, que e o que o determinismo
 * exige.
 */
const respirar = (ctx, nome) =>
  RITMO_SEGUNDOS > 0 ? ctx.wait(nome, { seconds: RITMO_SEGUNDOS }) : Promise.resolve();

async function fluxoDeCobranca(evento, ctx) {
  const { boletoId } = evento;
  ctx.logger.info("fluxo de cobranca iniciado", { boletoId });

  // ───────────────────────── 1. Emissao ─────────────────────────
  await ctx.step("registrar-emissao", async (step) => {
    const { nossoNumero, linhaDigitavel } = dadosBancarios(boletoId);
    await dormir(700); // registro no banco liquidante
    await store.avancar(boletoId, {
      status: STATUS.EMITIDO,
      stage: STAGE.EMISSAO,
      message: `Boleto registrado no banco liquidante sob o nosso numero ${nossoNumero}`,
      patch: { nossoNumero, linhaDigitavel },
      data: { nossoNumero, linhaDigitavel },
    });
    step.logger.info("boleto registrado", { nossoNumero });
    return { nossoNumero, linhaDigitavel };
  });

  // ──────────────── 2. Aguardar o webhook de pagamento ────────────────
  // Daqui ate o callback chegar, esta execucao nao existe em lugar nenhum
  // alem do log de checkpoints. Nenhuma Lambda de pe, nenhum custo.
  let pagamento;
  try {
    const respostaDoBanco = await ctx.waitForCallback(
      "aguardando-pagamento",
      async (callbackId, step) => {
        // O submitter roda ANTES da suspensao: e aqui que entregamos o
        // callbackId para o mundo externo. Guardamos no DynamoDB para a API
        // HTTP poder resolver esse callback quando o webhook chegar.
        await store.avancar(boletoId, {
          status: STATUS.AGUARDANDO_PAGAMENTO,
          stage: STAGE.PAGAMENTO,
          message: "Aguardando pagamento. Execucao suspensa: zero compute ate o webhook chegar.",
          patch: { callbackId },
          data: { callbackId, prazoHoras: HORAS_PARA_PAGAR },
        });
        step.logger.info("callback registrado, suspendendo execucao", { callbackId });
      },
      { timeout: { hours: HORAS_PARA_PAGAR } },
    );
    pagamento = JSON.parse(respostaDoBanco);
  } catch (erro) {
    // Estouro do timeout do callback: o boleto venceu sem pagamento.
    await ctx.step("registrar-vencimento", async () => {
      await store.avancar(boletoId, {
        status: STATUS.EXPIRADO,
        stage: STAGE.PAGAMENTO,
        level: "ERROR",
        message: `Boleto vencido sem pagamento apos ${HORAS_PARA_PAGAR}h (${erro.errorType ?? erro.name})`,
        patch: { erro: erro.message },
      });
    });
    return { boletoId, status: STATUS.EXPIRADO, motivo: erro.message };
  }

  await ctx.step("confirmar-pagamento", async (step) => {
    await store.avancar(boletoId, {
      status: STATUS.PAGO,
      stage: STAGE.PAGAMENTO,
      message: `Pagamento confirmado pelo banco: ${formatarBRL(pagamento.valorPagoCentavos)} via ${pagamento.canal}`,
      patch: { pagoEm: pagamento.pagoEm },
      data: pagamento,
    });
    step.logger.info("pagamento confirmado", pagamento);
  });

  // ───────────────────────── 3. Baixa ─────────────────────────
  // A compensacao interbancaria nao e instantanea. Assim como o callback, um
  // `wait` suspende a execucao de verdade — diferente de um sleep no handler.
  await respirar(ctx, "compensacao-interbancaria");

  const darBaixa = async (step) => {
    const inicio = Date.now();
    await store.avancar(boletoId, {
      status: STATUS.BAIXANDO,
      stage: STAGE.BAIXA,
      message:
        step.attempt === 1
          ? "Dando baixa no contas a receber"
          : `Dando baixa no contas a receber (tentativa ${step.attempt})`,
      attempt: step.attempt,
    });

    await aplicarCaos(boletoId, MODOS_CAOS.FALHAR_BAIXA, step.logger);
    // Derrubada ANTES do efeito: a conferencia vai constatar que nada foi
    // aplicado e refazer com seguranca.
    await aplicarCaos(boletoId, MODOS_CAOS.DERRUBAR_ANTES_BAIXA, step.logger);
    await dormir(1200);

    // ─── o efeito colateral irreversivel ───
    const comprovante = comprovanteBaixa(boletoId);
    await store.avancar(boletoId, {
      status: STATUS.BAIXADO,
      stage: STAGE.BAIXA,
      message: `Baixa efetivada, comprovante ${comprovante}`,
      attempt: step.attempt,
      durationMs: Date.now() - inicio,
      patch: { baixadoEm: new Date().toISOString(), comprovanteBaixa: comprovante },
    });

    // Derrubada DEPOIS do efeito e antes do checkpoint: e o caso perigoso, o
    // que faria uma baixa em duplicidade se o step fosse simplesmente
    // reexecutado. A conferencia acha o comprovante e nao refaz nada.
    await aplicarCaos(boletoId, MODOS_CAOS.DERRUBAR_APOS_BAIXA, step.logger);
    return { comprovante };
  };

  let baixa;
  try {
    baixa = await ctx.step("dar-baixa", darBaixa, {
      semantics: StepSemantics.AtMostOncePerRetry,
      retryStrategy: RETRY_BAIXA,
    });
  } catch (erro) {
    if (!foiInterrompido(erro)) throw erro;

    // A invocacao morreu no meio da baixa. Como o step e AtMostOncePerRetry,
    // o SDK nao repete: ele avisa que o resultado e desconhecido. Em vez de
    // tentar de novo as cegas (e arriscar baixa em duplicidade), conferimos
    // o estado real no sistema de contas a receber.
    baixa = await ctx.step("conferir-baixa", async (step) => {
      step.logger.warn("baixa interrompida sem checkpoint, conferindo estado real", { boletoId });
      const atual = await store.obterBoleto(boletoId);
      if (atual?.comprovanteBaixa) {
        await store.avancar(boletoId, {
          status: STATUS.BAIXADO,
          stage: STAGE.BAIXA,
          level: "WARN",
          message: `Invocacao caiu no meio da baixa, mas a conferencia achou o comprovante ${atual.comprovanteBaixa}. Nada foi refeito.`,
          data: { comprovante: atual.comprovanteBaixa, origem: "conferencia" },
        });
        return { comprovante: atual.comprovanteBaixa, conferido: true };
      }

      await store.avancar(boletoId, {
        stage: STAGE.BAIXA,
        level: "WARN",
        message: "Invocacao caiu antes de efetivar a baixa. Conferencia confirmou que nada foi aplicado, refazendo.",
      });
      const refeita = await darBaixa(step);
      return { ...refeita, conferido: true };
    });
  }

  // ──────────── 4. Extrato e notificacao, em paralelo ────────────
  // Sao independentes entre si, e ambos precisam terminar antes da
  // conciliacao. Cada ramo vira um contexto durable proprio: se um falhar e
  // for retentado, o outro nao e afetado.
  await respirar(ctx, "ritmo-antes-do-extrato");

  await ctx.step("iniciar-pos-baixa", async () => {
    await store.avancar(boletoId, {
      status: STATUS.GERANDO_EXTRATO,
      stage: STAGE.EXTRATO,
      message: "Gerando extrato e notificando o ERP em paralelo",
    });
  });

  const posBaixa = await ctx.parallel("pos-baixa", [
    {
      name: "gerar-extrato",
      func: async (filho) =>
        filho.step(
          "montar-extrato",
          async (step) => {
            const inicio = Date.now();
            await aplicarCaos(boletoId, MODOS_CAOS.FALHAR_EXTRATO, step.logger);
            await dormir(1500);

            const boleto = await store.obterBoleto(boletoId);
            const tarifa = TARIFA_LIQUIDACAO_CENTAVOS;
            // O caos de divergencia faz o banco reportar um liquido errado,
            // exatamente como um extrato bancario real de vez em quando faz.
            const ruido = (await consumirCaos(boletoId, MODOS_CAOS.DIVERGENCIA)) ? 1750 : 0;
            const valorLiquidoCentavos = boleto.valorCentavos - tarifa - ruido;
            const extrato = idExtrato(boletoId);

            await store.avancar(boletoId, {
              status: STATUS.EXTRATO_GERADO,
              stage: STAGE.EXTRATO,
              message: `Extrato ${extrato} gerado: liquido ${formatarBRL(valorLiquidoCentavos)} (tarifa ${formatarBRL(tarifa)})`,
              attempt: step.attempt,
              durationMs: Date.now() - inicio,
              patch: { extratoId: extrato, valorLiquidoCentavos, tarifaCentavos: tarifa },
              data: { extratoId: extrato, valorLiquidoCentavos, tarifaCentavos: tarifa },
            });
            return { extratoId: extrato, valorLiquidoCentavos, tarifaCentavos: tarifa };
          },
          // Gerar extrato e idempotente: reescrever o mesmo extrato duas vezes
          // nao causa dano, entao a semantica padrao (mais permissiva) serve.
          { semantics: StepSemantics.AtLeastOncePerRetry, retryStrategy: RETRY_EXTRATO },
        ),
    },
    {
      name: "notificar-erp",
      func: async (filho) =>
        filho.step("enviar-notificacao", async (step) => {
          await dormir(600);
          await store.avancar(boletoId, {
            stage: STAGE.EXTRATO,
            message: "ERP notificado da liquidacao do titulo",
            attempt: step.attempt,
          });
          return { notificado: true };
        }),
    },
  ]);

  // Os ramos sao identificados por `index`, nao pela posicao no array `all`:
  // a ordem de conclusao nao e a ordem de declaracao.
  const ramoExtrato = posBaixa.all.find((item) => item.index === 0);
  const extrato = ramoExtrato?.result;
  if (!extrato) {
    throw new Error(
      `Nao foi possivel gerar o extrato: ${ramoExtrato?.error?.message ?? "ramo nao concluido"}`,
    );
  }

  // ─────────────────────── 5. Conciliacao ───────────────────────
  await respirar(ctx, "ritmo-antes-da-conciliacao");

  const conciliacao = await ctx.step("conciliar", async (step) => {
    const inicio = Date.now();
    await store.avancar(boletoId, {
      status: STATUS.CONCILIANDO,
      stage: STAGE.CONCILIACAO,
      message: "Conferindo extrato contra o contas a receber",
      attempt: step.attempt,
    });
    await dormir(1300);

    const boleto = await store.obterBoleto(boletoId);
    const esperado = boleto.valorCentavos;
    const encontrado = extrato.valorLiquidoCentavos + extrato.tarifaCentavos;
    const divergenciaCentavos = esperado - encontrado;
    const conciliacaoId = idConciliacao(boletoId);

    await store.avancar(boletoId, {
      status: STATUS.CONCILIADO,
      stage: STAGE.CONCILIACAO,
      level: divergenciaCentavos === 0 ? "INFO" : "WARN",
      message:
        divergenciaCentavos === 0
          ? `Conciliacao ${conciliacaoId} fechada sem divergencia`
          : `Conciliacao ${conciliacaoId} fechada COM divergencia de ${formatarBRL(Math.abs(divergenciaCentavos))} — enviada para tratamento manual`,
      attempt: step.attempt,
      durationMs: Date.now() - inicio,
      patch: { conciliacaoId, divergenciaCentavos },
      data: { esperado, encontrado, divergenciaCentavos },
    });
    return { conciliacaoId, divergenciaCentavos };
  });

  // ─────────────────────────── 6. Fim ───────────────────────────
  await ctx.step("encerrar", async () => {
    await store.avancar(boletoId, {
      stage: STAGE.FIM,
      message: "Ciclo de cobranca concluido",
      data: { comprovante: baixa.comprovante, ...conciliacao },
    });
  });

  ctx.logger.info("fluxo de cobranca concluido", { boletoId, ...conciliacao });
  return {
    boletoId,
    status: STATUS.CONCILIADO,
    comprovanteBaixa: baixa.comprovante,
    extratoId: extrato.extratoId,
    ...conciliacao,
  };
}

/**
 * Registra a falha no boleto e propaga o erro: a execucao durable precisa
 * terminar em FAILED, senao a API de durable executions mentiria sobre o que
 * aconteceu.
 */
async function comRegistroDeFalha(evento, ctx) {
  try {
    return await fluxoDeCobranca(evento, ctx);
  } catch (erro) {
    ctx.logger.error("fluxo de cobranca falhou", { boletoId: evento?.boletoId, erro: erro.message });
    try {
      await ctx.step("registrar-falha", async () => {
        await store.avancar(evento.boletoId, {
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
