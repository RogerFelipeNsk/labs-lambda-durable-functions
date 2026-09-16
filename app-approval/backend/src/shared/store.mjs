/**
 * Camada de persistencia. Tabela unica no DynamoDB:
 *
 *   pk                        sk              o que e
 *   -------------------------  --------------  ----------------------------------------
 *   SOLICITACAO#<id>          META            a solicitacao e seu estado atual
 *   SOLICITACAO#<id>          EVT#000001..n   linha do tempo append-only do workflow
 *
 * O indice `by_created` (gsi1pk = "SOLICITACAO", gsi1sk = <createdAt>#<id>)
 * existe so para listar as solicitacoes do mais novo para o mais antigo sem
 * Scan.
 *
 * `avancar()` e a unica funcao que o workflow usa para mudar estado: ela grava
 * o novo estado, anexa um evento na timeline e publica os dois no AppSync.
 * Manter isso em um lugar so e o que garante que o frontend nunca ve uma
 * transicao sem o evento correspondente.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { publicarEvento, publicarSolicitacao } from "./appsync.mjs";

const TABELA = process.env.TABELA_SOLICITACOES;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const chaveSolicitacao = (id) => ({ pk: `SOLICITACAO#${id}`, sk: "META" });

/**
 * Monta um UpdateExpression a partir de um objeto simples, usando aliases para
 * todos os nomes. Sem isso, atributos como `status` quebram por serem palavras
 * reservadas do DynamoDB.
 */
function montarUpdate(campos) {
  const nomes = {};
  const valores = {};
  const partes = [];
  Object.entries(campos).forEach(([campo, valor], i) => {
    if (valor === undefined) return;
    nomes[`#k${i}`] = campo;
    valores[`:v${i}`] = valor;
    partes.push(`#k${i} = :v${i}`);
  });
  return { nomes, valores, expressao: partes.join(", ") };
}

export async function criarSolicitacao(solicitacao) {
  const item = {
    ...chaveSolicitacao(solicitacao.id),
    gsi1pk: "SOLICITACAO",
    gsi1sk: `${solicitacao.createdAt}#${solicitacao.id}`,
    seq: 0,
    ...solicitacao,
  };
  await ddb.send(
    new PutCommand({
      TableName: TABELA,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
  await publicarSolicitacao(item);
  return item;
}

export async function obterSolicitacao(id) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABELA, Key: chaveSolicitacao(id) }));
  return Item ?? null;
}

export async function listarSolicitacoes(limite = 50) {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABELA,
      IndexName: "by_created",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": "SOLICITACAO" },
      ScanIndexForward: false,
      Limit: limite,
    }),
  );
  return Items ?? [];
}

export async function listarEventos(solicitacaoId) {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABELA,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: { ":pk": `SOLICITACAO#${solicitacaoId}`, ":sk": "EVT#" },
      ScanIndexForward: true,
    }),
  );
  return Items ?? [];
}

/** Atualiza campos da solicitacao sem tocar na timeline nem publicar evento. */
export async function atualizarSolicitacao(id, campos) {
  const { nomes, valores, expressao } = montarUpdate({ ...campos, updatedAt: new Date().toISOString() });
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: TABELA,
      Key: chaveSolicitacao(id),
      UpdateExpression: `SET ${expressao}`,
      ExpressionAttributeNames: nomes,
      ExpressionAttributeValues: valores,
      ConditionExpression: "attribute_exists(pk)",
      ReturnValues: "ALL_NEW",
    }),
  );
  await publicarSolicitacao(Attributes);
  return Attributes;
}

/**
 * Avanca a solicitacao: grava o novo estado, anexa um evento na linha do
 * tempo e publica ambos no AppSync.
 *
 * O contador `seq` e incrementado atomicamente no proprio item META (clausula
 * ADD), o que da uma ordem total dos eventos mesmo com steps concorrentes
 * dentro de um `context.parallel`.
 */
export async function avancar(solicitacaoId, opcoes) {
  const { status, stage, message, level = "INFO", attempt, durationMs, data, patch = {} } = opcoes;
  const agora = new Date().toISOString();

  const { nomes, valores, expressao } = montarUpdate({
    ...patch,
    ...(status ? { status } : {}),
    ...(stage ? { stage } : {}),
    updatedAt: agora,
  });
  nomes["#seq"] = "seq";
  valores[":um"] = 1;

  const { Attributes: solicitacao } = await ddb.send(
    new UpdateCommand({
      TableName: TABELA,
      Key: chaveSolicitacao(solicitacaoId),
      UpdateExpression: `SET ${expressao} ADD #seq :um`,
      ExpressionAttributeNames: nomes,
      ExpressionAttributeValues: valores,
      ConditionExpression: "attribute_exists(pk)",
      ReturnValues: "ALL_NEW",
    }),
  );

  const evento = {
    pk: `SOLICITACAO#${solicitacaoId}`,
    sk: `EVT#${String(solicitacao.seq).padStart(6, "0")}`,
    solicitacaoId,
    seq: solicitacao.seq,
    at: agora,
    stage: stage ?? solicitacao.stage ?? "desconhecido",
    level,
    message,
    attempt,
    durationMs,
    data: data === undefined ? undefined : JSON.stringify(data),
  };
  await ddb.send(new PutCommand({ TableName: TABELA, Item: evento }));

  await publicarSolicitacao(solicitacao);
  await publicarEvento(evento);
  return solicitacao;
}
