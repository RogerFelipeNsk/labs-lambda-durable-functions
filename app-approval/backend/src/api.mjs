/**
 * API HTTP do laboratorio (API Gateway HTTP API, payload v2).
 *
 * Esta Lambda e comum — nao e durable. Ela e a fronteira entre o mundo
 * externo e a execucao durable:
 *
 *   POST /solicitacoes                    emite a solicitacao e INICIA a durable execution
 *   POST /solicitacoes/{id}/decidir       o aprovador clica Aprovar/Rejeitar — RESOLVE o callback
 *   POST /solicitacoes/{id}/caos          arma um modo de caos no proximo step
 *   POST /solicitacoes/{id}/parar         StopDurableExecution
 *   GET  /solicitacoes                    lista (o frontend usa o AppSync; isto e para curl)
 *   GET  /solicitacoes/{id}/execucao      GetDurableExecution: a visao da AWS, nao a nossa
 *
 * A rota `/decidir` e o coracao deste lab: e literalmente o clique do
 * aprovador nesta mesma interface virando `SendDurableExecutionCallbackSuccess`
 * (ou `Failure`, para o caso de indisponibilidade tecnica do financeiro).
 */
import { Buffer } from "node:buffer";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  GetDurableExecutionCommand,
  InvokeCommand,
  LambdaClient,
  SendDurableExecutionCallbackFailureCommand,
  SendDurableExecutionCallbackSuccessCommand,
  StopDurableExecutionCommand,
} from "@aws-sdk/client-lambda";
import { MODOS_CAOS } from "./shared/chaos.mjs";
import { PAPEIS, STATUS, STATUS_TERMINAIS, capitalizar } from "./shared/domain.mjs";
import * as store from "./shared/store.mjs";

const lambda = new LambdaClient({});
const ORQUESTRADOR = process.env.ORQUESTRADOR_ARN; // ARN qualificado (alias)
const TOKEN_API = process.env.TOKEN_API;
const codificar = (objeto) => new TextEncoder().encode(JSON.stringify(objeto));

const responder = (statusCode, corpo) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(corpo),
});
const erro = (statusCode, mensagem, extra = {}) => responder(statusCode, { erro: mensagem, ...extra });

/**
 * Compara dois segredos em tempo constante. Ver a mesma funcao em
 * app/backend/src/api.mjs para a explicacao completa.
 */
function tokenConfere(recebido) {
  if (typeof recebido !== "string" || recebido.length !== TOKEN_API.length) return false;
  return timingSafeEqual(Buffer.from(recebido), Buffer.from(TOKEN_API));
}

/** POST /solicitacoes — cria a solicitacao e dispara a execucao durable. */
async function criarSolicitacao(corpo) {
  const solicitante = String(corpo.solicitante ?? "").trim();
  const valorCentavos = Number(corpo.valorCentavos);
  if (!solicitante) return erro(400, "informe o solicitante");
  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) {
    return erro(400, "valorCentavos deve ser um inteiro positivo");
  }

  const id = randomUUID();
  const agora = new Date().toISOString();
  await store.criarSolicitacao({
    id,
    solicitante,
    descricao: String(corpo.descricao ?? "").trim() || null,
    valorCentavos,
    status: STATUS.SOLICITADA,
    stage: "solicitacao",
    createdAt: agora,
    updatedAt: agora,
  });

  // O id da solicitacao vira o nome da execucao durable — idempotencia de
  // graca, igual ao app de boleto. O ARN precisa ser qualificado (alias ou
  // versao): funcoes durable recusam ARN sem qualificador.
  const invocacao = await lambda.send(
    new InvokeCommand({
      FunctionName: ORQUESTRADOR,
      InvocationType: "Event",
      DurableExecutionName: id,
      Payload: codificar({ solicitacaoId: id, valorCentavos }),
    }),
  );

  const solicitacao = await store.atualizarSolicitacao(id, {
    executionArn: invocacao.DurableExecutionArn ?? null,
  });
  return responder(201, { solicitacao, durableExecutionArn: invocacao.DurableExecutionArn ?? null });
}

const PAPEIS_VALIDOS = new Set(Object.values(PAPEIS));

/**
 * POST /solicitacoes/{id}/decidir — o aprovador age. E aqui que o clique de
 * um humano nesta UI vira a resolucao de um `waitForCallback` suspenso.
 *
 * `decisao` aceita "aprovado" ou "rejeitado" — ambos resolvidos com
 * `SendDurableExecutionCallbackSuccess`, porque rejeitar e um resultado de
 * negocio valido. Para o papel "financeiro" tambem aceita "falha-tecnica",
 * que usa `SendDurableExecutionCallbackFailure` de verdade: o financeiro
 * relatando que nao consegue processar agora, nao uma decisao de negocio.
 */
async function decidir(id, corpo) {
  const papel = String(corpo.papel ?? "");
  const decisao = String(corpo.decisao ?? "");
  if (!PAPEIS_VALIDOS.has(papel)) {
    return erro(400, `papel invalido; use um de: ${[...PAPEIS_VALIDOS].join(", ")}`);
  }
  if (papel !== PAPEIS.FINANCEIRO && decisao === "falha-tecnica") {
    return erro(400, "falha-tecnica so se aplica ao papel financeiro");
  }
  if (!["aprovado", "rejeitado", "falha-tecnica"].includes(decisao)) {
    return erro(400, 'decisao deve ser "aprovado", "rejeitado" ou "falha-tecnica" (so financeiro)');
  }

  const solicitacao = await store.obterSolicitacao(id);
  if (!solicitacao) return erro(404, "solicitacao nao encontrada");

  const Papel = capitalizar(papel);
  const callbackId = solicitacao[`callbackId${Papel}`];
  const jaDecidido = solicitacao[`decisao${Papel}`];
  if (!callbackId) {
    return erro(409, `ainda nao ha um callback de ${papel} aberto nesta solicitacao`, { status: solicitacao.status });
  }
  if (jaDecidido) {
    return erro(409, `${papel} ja decidiu esta solicitacao`, { decisao: jaDecidido });
  }

  if (decisao === "falha-tecnica") {
    await lambda.send(
      new SendDurableExecutionCallbackFailureCommand({
        CallbackId: callbackId,
        Error: {
          ErrorType: "FinanceiroIndisponivel",
          ErrorMessage: String(corpo.comentario ?? "Financeiro reportou indisponibilidade tecnica"),
        },
      }),
    );
    return responder(202, { mensagem: "falha tecnica reportada ao workflow" });
  }

  await lambda.send(
    new SendDurableExecutionCallbackSuccessCommand({
      CallbackId: callbackId,
      Result: codificar({
        decisao,
        aprovador: String(corpo.aprovador ?? papel),
        comentario: corpo.comentario ? String(corpo.comentario) : undefined,
      }),
    }),
  );
  return responder(202, { mensagem: `decisao de ${papel} (${decisao}) enviada ao workflow` });
}

/** POST /solicitacoes/{id}/caos — arma uma falha para o proximo step relevante. */
async function armarCaos(id, corpo) {
  const modo = String(corpo.modo ?? "");
  const modosValidos = Object.values(MODOS_CAOS);
  if (modo !== "nenhum" && !modosValidos.includes(modo)) {
    return erro(400, `modo invalido; use "nenhum" ou um de: ${modosValidos.join(", ")}`);
  }
  const vezes = modo === "nenhum" ? 0 : Math.min(Math.max(Number(corpo.vezes ?? 2), 1), 5);
  const solicitacao = await store.atualizarSolicitacao(id, {
    chaos: modo === "nenhum" ? null : modo,
    chaosRestante: vezes,
  });
  return responder(200, { solicitacao });
}

/** POST /solicitacoes/{id}/parar — encerra a execucao durable pelo lado da AWS. */
async function pararExecucao(id) {
  const solicitacao = await store.obterSolicitacao(id);
  if (!solicitacao) return erro(404, "solicitacao nao encontrada");
  if (!solicitacao.executionArn) return erro(409, "esta solicitacao nao tem execucao durable associada");
  if (STATUS_TERMINAIS.has(solicitacao.status)) {
    return erro(409, "a execucao ja terminou", { status: solicitacao.status });
  }

  await lambda.send(
    new StopDurableExecutionCommand({
      DurableExecutionArn: solicitacao.executionArn,
      Error: {
        ErrorType: "CanceladoPeloOperador",
        ErrorMessage: "Solicitacao cancelada manualmente pelo painel de caos",
      },
    }),
  );

  await store.avancar(id, {
    status: STATUS.CANCELADA,
    stage: "fim",
    level: "ERROR",
    message: "Execucao durable interrompida por StopDurableExecution. Nenhuma retomada acontecera.",
  });
  return responder(202, { mensagem: "execucao interrompida" });
}

/** GET /solicitacoes/{id}/execucao — o estado segundo a AWS, nao segundo a nossa tabela. */
async function consultarExecucao(id) {
  const solicitacao = await store.obterSolicitacao(id);
  if (!solicitacao) return erro(404, "solicitacao nao encontrada");
  if (!solicitacao.executionArn) return erro(409, "esta solicitacao nao tem execucao durable associada");

  const execucao = await lambda.send(
    new GetDurableExecutionCommand({ DurableExecutionArn: solicitacao.executionArn, IncludeExecutionData: true }),
  );
  return responder(200, {
    arn: execucao.DurableExecutionArn,
    nome: execucao.DurableExecutionName,
    status: execucao.Status,
    versao: execucao.Version,
    inicio: execucao.StartTimestamp,
    fim: execucao.EndTimestamp ?? null,
    resultado: execucao.Result ? JSON.parse(execucao.Result) : null,
    erro: execucao.Error ?? null,
  });
}

export async function handler(evento) {
  const rota = evento.routeKey ?? `${evento.requestContext?.http?.method} ${evento.rawPath}`;
  const id = evento.pathParameters?.id;
  let corpo = {};
  if (evento.body) {
    try {
      corpo = JSON.parse(evento.isBase64Encoded ? Buffer.from(evento.body, "base64").toString() : evento.body);
    } catch {
      return erro(400, "corpo nao e um JSON valido");
    }
  }

  // A rota de saude fica aberta de proposito, para health check — mas nao
  // revela nada: nem ARN, nem nome de recurso.
  if (rota === "GET /saude") return responder(200, { ok: true });

  // Todo o resto exige o token compartilhado. Sem isto a API seria um
  // endpoint anonimo na internet capaz de criar execucoes durable na sua
  // conta e de aprovar/rejeitar solicitacoes de qualquer valor.
  const cabecalhos = evento.headers ?? {};
  if (!tokenConfere(cabecalhos["x-lab-token"] ?? cabecalhos["X-Lab-Token"])) {
    return erro(401, "token ausente ou invalido; use o header x-lab-token");
  }

  try {
    switch (rota) {
      case "POST /solicitacoes":
        return await criarSolicitacao(corpo);
      case "GET /solicitacoes":
        return responder(200, { solicitacoes: await store.listarSolicitacoes() });
      case "GET /solicitacoes/{id}": {
        const solicitacao = await store.obterSolicitacao(id);
        return solicitacao
          ? responder(200, { solicitacao, eventos: await store.listarEventos(id) })
          : erro(404, "solicitacao nao encontrada");
      }
      case "POST /solicitacoes/{id}/decidir":
        return await decidir(id, corpo);
      case "POST /solicitacoes/{id}/caos":
        return await armarCaos(id, corpo);
      case "POST /solicitacoes/{id}/parar":
        return await pararExecucao(id);
      case "GET /solicitacoes/{id}/execucao":
        return await consultarExecucao(id);
      default:
        return erro(404, `rota desconhecida: ${rota}`);
    }
  } catch (falha) {
    console.error("falha na API", { rota, id, erro: falha });
    if (falha.name === "ConditionalCheckFailedException") return erro(404, "solicitacao nao encontrada");
    if (falha.name === "DurableExecutionAlreadyStartedException") {
      return erro(409, "ja existe uma execucao com este nome e payload diferente");
    }
    return erro(500, falha.message ?? "erro inesperado", { tipo: falha.name });
  }
}
