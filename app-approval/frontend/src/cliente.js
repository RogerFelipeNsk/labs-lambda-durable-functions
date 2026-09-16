/**
 * Conexao com o AppSync e com a API HTTP.
 *
 * O navegador usa a API key e so consegue LER e ASSINAR: as mutations de
 * publicacao exigem IAM e sao exclusivas das Lambdas. Toda acao de escrita do
 * frontend passa pela API HTTP, nunca pelo GraphQL — inclusive a decisao de
 * aprovacao, que e o clique de um humano virando a resolucao de um callback.
 */
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/api";

const faltando = [
  "VITE_APPSYNC_ENDPOINT",
  "VITE_APPSYNC_API_KEY",
  "VITE_API_URL",
  "VITE_API_TOKEN",
].filter((chave) => !import.meta.env[chave]);
if (faltando.length) {
  throw new Error(
    `Faltam variaveis de ambiente: ${faltando.join(", ")}.\n` +
      "Rode 'tofu apply' em infra/ — ele gera frontend/.env.local automaticamente.",
  );
}

Amplify.configure({
  API: {
    GraphQL: {
      endpoint: import.meta.env.VITE_APPSYNC_ENDPOINT,
      region: import.meta.env.VITE_AWS_REGION,
      defaultAuthMode: "apiKey",
      apiKey: import.meta.env.VITE_APPSYNC_API_KEY,
    },
  },
});

export const graphql = generateClient();

const BASE_API = import.meta.env.VITE_API_URL.replace(/\/$/, "");

async function chamar(caminho, opcoes = {}) {
  const resposta = await fetch(`${BASE_API}${caminho}`, {
    headers: {
      "content-type": "application/json",
      // Token compartilhado gerado pelo OpenTofu. Ele fecha o acesso anonimo
      // a API; nao e credencial de usuario e nao identifica ninguem.
      "x-lab-token": import.meta.env.VITE_API_TOKEN,
    },
    ...opcoes,
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(dados.erro ?? `HTTP ${resposta.status}`);
  return dados;
}

export const api = {
  solicitar: (solicitacao) => chamar("/solicitacoes", { method: "POST", corpo: solicitacao }),
  decidir: (id, papel, decisao, extra = {}) =>
    chamar(`/solicitacoes/${id}/decidir`, { method: "POST", corpo: { papel, decisao, ...extra } }),
  armarCaos: (id, modo, vezes) => chamar(`/solicitacoes/${id}/caos`, { method: "POST", corpo: { modo, vezes } }),
  parar: (id) => chamar(`/solicitacoes/${id}/parar`, { method: "POST" }),
  execucao: (id) => chamar(`/solicitacoes/${id}/execucao`),
};

// ── Documentos GraphQL ────────────────────────────────────────────────────────

const CAMPOS_SOLICITACAO = `
  id solicitante descricao valorCentavos status stage
  createdAt updatedAt executionArn attempt chaos chaosRestante
  precisaFinanceiro
  callbackIdGestor callbackIdDiretoria callbackIdFinanceiro
  decisaoGestor decisaoDiretoria decisaoFinanceiro
  aprovadorGestor aprovadorDiretoria aprovadorFinanceiro
  comentarioGestor comentarioDiretoria comentarioFinanceiro
  comprovante executadoEm erro
`;

const CAMPOS_EVENTO = `solicitacaoId seq at stage level message attempt durationMs data`;

export const LISTAR_SOLICITACOES = `query ListSolicitacoes { listSolicitacoes(limit: 50) { items { ${CAMPOS_SOLICITACAO} } } }`;
export const LISTAR_EVENTOS = `query ListEvents($solicitacaoId: ID!) { listEvents(solicitacaoId: $solicitacaoId) { items { ${CAMPOS_EVENTO} } } }`;
export const AO_MUDAR_SOLICITACAO = `subscription OnSolicitacaoChanged { onSolicitacaoChanged { ${CAMPOS_SOLICITACAO} } }`;
export const AO_CHEGAR_EVENTO = `subscription OnEvent { onEvent { ${CAMPOS_EVENTO} } }`;
