/**
 * API HTTP do laboratorio (API Gateway HTTP API, payload v2).
 *
 * Esta Lambda e comum — nao e durable. Ela e a fronteira entre o mundo
 * externo e a execucao durable:
 *
 *   POST /boletos                  emite o boleto e INICIA a durable execution
 *   POST /boletos/{id}/pagar       simula o webhook do banco e RESOLVE o callback
 *   POST /boletos/{id}/caos        arma um modo de caos no proximo step
 *   POST /boletos/{id}/parar       StopDurableExecution
 *   GET  /boletos                  lista (o frontend usa o AppSync; isto e para curl)
 *   GET  /boletos/{id}/execucao    GetDurableExecution: a visao da AWS, nao a nossa
 */
import { Buffer } from "node:buffer";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  GetDurableExecutionCommand,
  InvokeCommand,
  LambdaClient,
  SendDurableExecutionCallbackSuccessCommand,
  StopDurableExecutionCommand,
} from "@aws-sdk/client-lambda";
import { MODOS_CAOS } from "./shared/chaos.mjs";
import { STATUS, STATUS_TERMINAIS, formatarBRL } from "./shared/domain.mjs";
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
 * Compara dois segredos em tempo constante.
 *
 * Um `===` vaza, pelo tempo de resposta, quantos caracteres iniciais batem —
 * o que permite descobrir o token byte a byte. Aqui o risco e teorico (a
 * latencia de rede abafa tudo), mas usar a primitiva certa custa nada e evita
 * que alguem copie o padrao errado para um lugar onde importa.
 */
function tokenConfere(recebido) {
  if (typeof recebido !== "string" || recebido.length !== TOKEN_API.length) return false;
  return timingSafeEqual(Buffer.from(recebido), Buffer.from(TOKEN_API));
}

/** POST /boletos — emite o boleto e dispara a execucao durable. */
async function emitirBoleto(corpo) {
  const sacado = String(corpo.sacado ?? "").trim();
  const valorCentavos = Number(corpo.valorCentavos);
  if (!sacado) return erro(400, "informe o sacado");
  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) {
    return erro(400, "valorCentavos deve ser um inteiro positivo");
  }

  const id = randomUUID();
  const agora = new Date().toISOString();
  await store.criarBoleto({
    id,
    sacado,
    descricao: String(corpo.descricao ?? "").trim() || null,
    valorCentavos,
    status: STATUS.EMITIDO,
    stage: "emissao",
    createdAt: agora,
    updatedAt: agora,
  });

  // O id do boleto vira o nome da execucao durable. Isso da idempotencia de
  // graca: reenviar o mesmo POST com o mesmo id devolve a execucao existente
  // em vez de abrir uma segunda. O ARN precisa ser qualificado (alias ou
  // versao) — funcoes durable recusam ARN sem qualificador.
  const invocacao = await lambda.send(
    new InvokeCommand({
      FunctionName: ORQUESTRADOR,
      InvocationType: "Event",
      DurableExecutionName: id,
      Payload: codificar({ boletoId: id }),
    }),
  );

  const boleto = await store.atualizarBoleto(id, {
    executionArn: invocacao.DurableExecutionArn ?? null,
  });
  return responder(201, { boleto, durableExecutionArn: invocacao.DurableExecutionArn ?? null });
}

/** POST /boletos/{id}/pagar — o "webhook do banco" que acorda a execucao. */
async function pagarBoleto(id, corpo) {
  const boleto = await store.obterBoleto(id);
  if (!boleto) return erro(404, "boleto nao encontrado");
  if (!boleto.callbackId) {
    return erro(409, "a execucao ainda nao registrou o callback de pagamento; tente de novo em instantes", {
      status: boleto.status,
    });
  }
  if (boleto.pagoEm) return erro(409, "boleto ja foi pago", { pagoEm: boleto.pagoEm });

  const pagamento = {
    valorPagoCentavos: Number.isInteger(corpo.valorPagoCentavos) ? corpo.valorPagoCentavos : boleto.valorCentavos,
    canal: String(corpo.canal ?? "PIX"),
    pagoEm: new Date().toISOString(),
    autenticacao: randomUUID().slice(0, 18).toUpperCase(),
  };

  // Aqui a execucao suspensa volta a vida. Nao invocamos a Lambda: entregamos
  // o resultado do callback e a propria Lambda service reinvoca a funcao,
  // reproduz os checkpoints e continua de onde parou.
  await lambda.send(
    new SendDurableExecutionCallbackSuccessCommand({
      CallbackId: boleto.callbackId,
      Result: codificar(pagamento),
    }),
  );

  return responder(202, {
    mensagem: `pagamento de ${formatarBRL(pagamento.valorPagoCentavos)} enviado ao workflow`,
    pagamento,
  });
}

/** POST /boletos/{id}/caos — arma uma falha para o proximo step relevante. */
async function armarCaos(id, corpo) {
  const modo = String(corpo.modo ?? "");
  const modosValidos = Object.values(MODOS_CAOS);
  if (modo !== "nenhum" && !modosValidos.includes(modo)) {
    return erro(400, `modo invalido; use "nenhum" ou um de: ${modosValidos.join(", ")}`);
  }
  const vezes = modo === "nenhum" ? 0 : Math.min(Math.max(Number(corpo.vezes ?? 2), 1), 5);
  const boleto = await store.atualizarBoleto(id, {
    chaos: modo === "nenhum" ? null : modo,
    chaosRestante: vezes,
  });
  return responder(200, { boleto });
}

/** POST /boletos/{id}/parar — encerra a execucao durable pelo lado da AWS. */
async function pararExecucao(id) {
  const boleto = await store.obterBoleto(id);
  if (!boleto) return erro(404, "boleto nao encontrado");
  if (!boleto.executionArn) return erro(409, "esta cobranca nao tem execucao durable associada");
  if (STATUS_TERMINAIS.has(boleto.status)) {
    return erro(409, "a execucao ja terminou", { status: boleto.status });
  }

  await lambda.send(
    new StopDurableExecutionCommand({
      DurableExecutionArn: boleto.executionArn,
      Error: {
        ErrorType: "CanceladoPeloOperador",
        ErrorMessage: "Cobranca cancelada manualmente pelo painel de caos",
      },
    }),
  );

  // A execucao morre sem rodar mais nenhum step, entao quem registra o
  // desfecho na timeline e a API.
  await store.avancar(id, {
    status: STATUS.CANCELADO,
    stage: "fim",
    level: "ERROR",
    message: "Execucao durable interrompida por StopDurableExecution. Nenhuma retomada acontecera.",
  });
  return responder(202, { mensagem: "execucao interrompida" });
}

/** GET /boletos/{id}/execucao — o estado segundo a AWS, nao segundo a nossa tabela. */
async function consultarExecucao(id) {
  const boleto = await store.obterBoleto(id);
  if (!boleto) return erro(404, "boleto nao encontrado");
  if (!boleto.executionArn) return erro(409, "esta cobranca nao tem execucao durable associada");

  const execucao = await lambda.send(
    new GetDurableExecutionCommand({ DurableExecutionArn: boleto.executionArn, IncludeExecutionData: true }),
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

  // Todo o resto exige o token compartilhado. Sem isto a API seria um endpoint
  // anonimo na internet capaz de criar execucoes durable na sua conta.
  const cabecalhos = evento.headers ?? {};
  if (!tokenConfere(cabecalhos["x-lab-token"] ?? cabecalhos["X-Lab-Token"])) {
    return erro(401, "token ausente ou invalido; use o header x-lab-token");
  }

  try {
    switch (rota) {
      case "POST /boletos":
        return await emitirBoleto(corpo);
      case "GET /boletos":
        return responder(200, { boletos: await store.listarBoletos() });
      case "GET /boletos/{id}": {
        const boleto = await store.obterBoleto(id);
        return boleto
          ? responder(200, { boleto, eventos: await store.listarEventos(id) })
          : erro(404, "boleto nao encontrado");
      }
      case "POST /boletos/{id}/pagar":
        return await pagarBoleto(id, corpo);
      case "POST /boletos/{id}/caos":
        return await armarCaos(id, corpo);
      case "POST /boletos/{id}/parar":
        return await pararExecucao(id);
      case "GET /boletos/{id}/execucao":
        return await consultarExecucao(id);
      default:
        return erro(404, `rota desconhecida: ${rota}`);
    }
  } catch (falha) {
    console.error("falha na API", { rota, id, erro: falha });
    if (falha.name === "ConditionalCheckFailedException") return erro(404, "boleto nao encontrado");
    if (falha.name === "DurableExecutionAlreadyStartedException") {
      return erro(409, "ja existe uma execucao com este nome e payload diferente");
    }
    return erro(500, falha.message ?? "erro inesperado", { tipo: falha.name });
  }
}
