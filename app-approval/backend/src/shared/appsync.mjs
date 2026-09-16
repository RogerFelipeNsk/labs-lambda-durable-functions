/**
 * Publicador de eventos no AppSync.
 *
 * O DynamoDB e a fonte da verdade: quem escreve nele e o backend. O AppSync
 * entra so como canal de tempo real — as mutations `publishSolicitacao` e
 * `publishEvent` usam um data source NONE (resolver local), ou seja, nao
 * persistem nada: elas apenas disparam as subscriptions conectadas.
 *
 * A chamada e assinada com SigV4 porque a API AppSync aceita API_KEY (para o
 * frontend, somente leitura e subscription) e AWS_IAM (para estas Lambdas, as
 * unicas que podem publicar). Assim o navegador nunca consegue forjar um
 * evento de "solicitacao aprovada".
 */
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

const endpoint = new URL(process.env.APPSYNC_ENDPOINT);

// Em Lambda as credenciais da execution role chegam por variavel de ambiente,
// entao nao precisamos da cadeia completa de credential providers.
const signer = new SignatureV4({
  service: "appsync",
  region: process.env.AWS_REGION,
  sha256: Sha256,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
});

async function executar(query, variables) {
  const body = JSON.stringify({ query, variables });
  const assinada = await signer.sign(
    new HttpRequest({
      method: "POST",
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      path: endpoint.pathname,
      headers: { "content-type": "application/json", host: endpoint.hostname },
      body,
    }),
  );

  const resposta = await fetch(endpoint.toString(), {
    method: "POST",
    headers: assinada.headers,
    body,
  });

  if (!resposta.ok) {
    throw new Error(`AppSync respondeu ${resposta.status}: ${await resposta.text()}`);
  }
  const json = await resposta.json();
  if (json.errors?.length) {
    throw new Error(`AppSync retornou erros: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const MUTATION_SOLICITACAO = /* GraphQL */ `
  mutation PublishSolicitacao($input: SolicitacaoInput!) {
    publishSolicitacao(input: $input) {
      id
      solicitante
      descricao
      valorCentavos
      status
      stage
      createdAt
      updatedAt
      executionArn
      attempt
      chaos
      chaosRestante
      precisaFinanceiro
      callbackIdGestor
      callbackIdDiretoria
      callbackIdFinanceiro
      decisaoGestor
      decisaoDiretoria
      decisaoFinanceiro
      aprovadorGestor
      aprovadorDiretoria
      aprovadorFinanceiro
      comentarioGestor
      comentarioDiretoria
      comentarioFinanceiro
      comprovante
      executadoEm
      erro
    }
  }
`;

const MUTATION_EVENTO = /* GraphQL */ `
  mutation PublishEvent($input: TimelineEventInput!) {
    publishEvent(input: $input) {
      solicitacaoId
      seq
      at
      stage
      level
      message
      attempt
      durationMs
      data
    }
  }
`;

/**
 * Remove chaves nulas/indefinidas: o AppSync rejeita campos nao-nullable que
 * chegam como null, e o DynamoDB devolve o item sem os atributos ausentes.
 */
function limpar(objeto) {
  return Object.fromEntries(Object.entries(objeto).filter(([, v]) => v !== null && v !== undefined));
}

/** Campos do item do DynamoDB que existem no schema GraphQL de Solicitacao. */
const CAMPOS_SOLICITACAO = [
  "id", "solicitante", "descricao", "valorCentavos", "status", "stage",
  "createdAt", "updatedAt", "executionArn", "attempt", "chaos", "chaosRestante",
  "precisaFinanceiro", "callbackIdGestor", "callbackIdDiretoria", "callbackIdFinanceiro",
  "decisaoGestor", "decisaoDiretoria", "decisaoFinanceiro",
  "aprovadorGestor", "aprovadorDiretoria", "aprovadorFinanceiro",
  "comentarioGestor", "comentarioDiretoria", "comentarioFinanceiro",
  "comprovante", "executadoEm", "erro",
];

export async function publicarSolicitacao(item) {
  const input = limpar(Object.fromEntries(CAMPOS_SOLICITACAO.map((c) => [c, item[c]])));
  await executar(MUTATION_SOLICITACAO, { input });
}

export async function publicarEvento(evento) {
  const input = limpar({
    solicitacaoId: evento.solicitacaoId,
    seq: evento.seq,
    at: evento.at,
    stage: evento.stage,
    level: evento.level,
    message: evento.message,
    attempt: evento.attempt,
    durationMs: evento.durationMs,
    data: evento.data,
  });
  await executar(MUTATION_EVENTO, { input });
}
