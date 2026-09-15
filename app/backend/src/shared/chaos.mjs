/**
 * Laboratorio de caos.
 *
 * O frontend arma um modo de caos no boleto antes (ou durante) o fluxo; os
 * steps consultam aqui se devem falhar. Cada modo tem um "orcamento"
 * (`chaosRestante`) decrementado atomicamente no DynamoDB, entao o step falha
 * N vezes e depois passa — que e o unico jeito de ver o backoff exponencial
 * do durable acontecendo de verdade, em vez de uma falha terminal.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const TABELA = process.env.TABELA_BOLETOS;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const MODOS_CAOS = {
  /** Lanca erro transitorio na baixa: mostra retry com backoff exponencial. */
  FALHAR_BAIXA: "falhar-baixa",
  /** Lanca erro transitorio na geracao do extrato, dentro de um ramo paralelo. */
  FALHAR_EXTRATO: "falhar-extrato",
  /** Mata o processo ANTES de efetivar a baixa: a conferencia refaz. */
  DERRUBAR_ANTES_BAIXA: "derrubar-antes-baixa",
  /** Mata o processo DEPOIS do efeito e ANTES do checkpoint: a conferencia
   *  encontra o comprovante e nao refaz. E o caso que justifica o padrao. */
  DERRUBAR_APOS_BAIXA: "derrubar-apos-baixa",
  /** Extrato vem com valor diferente: a conciliacao acusa divergencia. */
  DIVERGENCIA: "divergencia",
};

/** Erro transitorio simulado. Nomeado para aparecer legivel no histórico. */
export class FalhaTransitoriaError extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = "FalhaTransitoriaError";
  }
}

/**
 * Consome uma unidade do orcamento de caos, se o modo pedido estiver armado.
 *
 * O decremento condicional (`chaosRestante > 0`) e atomico: mesmo que o step
 * rode duas vezes por replay, o orcamento nunca fica negativo e o numero de
 * falhas observadas e exatamente o que o usuario pediu.
 *
 * @returns `true` se este step deve falhar agora.
 */
export async function consumirCaos(boletoId, modo) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABELA,
        Key: { pk: `BOLETO#${boletoId}`, sk: "META" },
        UpdateExpression: "ADD #restante :menosUm",
        ConditionExpression: "#chaos = :modo AND #restante > :zero",
        ExpressionAttributeNames: { "#chaos": "chaos", "#restante": "chaosRestante" },
        ExpressionAttributeValues: { ":menosUm": -1, ":modo": modo, ":zero": 0 },
      }),
    );
    return true;
  } catch (erro) {
    if (erro.name === "ConditionalCheckFailedException") return false;
    throw erro;
  }
}

/** Le se um modo de caos esta armado, sem consumir orcamento. */
export async function caosArmado(boleto, modo) {
  return boleto?.chaos === modo && (boleto?.chaosRestante ?? 0) > 0;
}

/**
 * Aplica o caos configurado para um step: ou nao faz nada, ou lanca um erro
 * transitorio, ou mata o processo (simulando a sandbox da Lambda morrendo no
 * pior momento possivel, com o efeito colateral ja aplicado ou nao).
 */
export async function aplicarCaos(boletoId, modo, logger) {
  if (!(await consumirCaos(boletoId, modo))) return;

  if (modo === MODOS_CAOS.DERRUBAR_ANTES_BAIXA || modo === MODOS_CAOS.DERRUBAR_APOS_BAIXA) {
    logger?.warn?.("[caos] derrubando o processo", { boletoId, modo });
    // Sem graca nenhuma: encerra o runtime. A durable execution vai reinvocar
    // a funcao e o SDK vai reproduzir o log de checkpoints ate este ponto.
    process.exit(1);
  }

  logger?.warn?.("[caos] injetando falha transitoria", { boletoId, modo });
  throw new FalhaTransitoriaError(`Falha transitoria injetada pelo painel de caos (modo=${modo})`);
}

/**
 * Detecta o caso em que o SDK se recusou a repetir um step porque a invocacao
 * anterior morreu antes do checkpoint de conclusao.
 *
 * So chega aqui se DUAS coisas estiverem no lugar: o step usar
 * `AtMostOncePerRetry` e a politica de retry recusar `StepInterruptedError`
 * (veja RETRY_BAIXA em orchestrator.mjs). Com uma politica que aceita retry,
 * o SDK simplesmente reexecuta o step e este caminho nunca roda.
 *
 * Esse erro nao quer dizer "deu errado": quer dizer "nao sei se deu certo".
 * A diferenca e o coracao de um fluxo financeiro — por isso o orquestrador
 * responde a ele com uma etapa de conferencia, e nao com um retry cego.
 */
export function foiInterrompido(erro) {
  return erro?.cause?.name === "StepInterruptedError" || erro?.name === "StepInterruptedError";
}
