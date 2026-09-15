/**
 * Conexao com o AppSync e com a API HTTP.
 *
 * O navegador usa a API key e so consegue LER e ASSINAR: as mutations de
 * publicacao exigem IAM e sao exclusivas das Lambdas. Toda acao de escrita do
 * frontend passa pela API HTTP, nunca pelo GraphQL.
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
      "Rode 'tofu apply' em app/infra — ele gera app/frontend/.env.local automaticamente.",
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
  emitir: (boleto) => chamar("/boletos", { method: "POST", corpo: boleto }),
  pagar: (id, dados = {}) => chamar(`/boletos/${id}/pagar`, { method: "POST", corpo: dados }),
  armarCaos: (id, modo, vezes) => chamar(`/boletos/${id}/caos`, { method: "POST", corpo: { modo, vezes } }),
  parar: (id) => chamar(`/boletos/${id}/parar`, { method: "POST" }),
  execucao: (id) => chamar(`/boletos/${id}/execucao`),
};

// ── Documentos GraphQL ────────────────────────────────────────────────────────

const CAMPOS_BOLETO = `
  id sacado descricao valorCentavos status stage
  nossoNumero linhaDigitavel createdAt updatedAt
  executionArn callbackId attempt chaos chaosRestante
  pagoEm baixadoEm comprovanteBaixa extratoId conciliacaoId
  valorLiquidoCentavos tarifaCentavos divergenciaCentavos erro
`;

const CAMPOS_EVENTO = `boletoId seq at stage level message attempt durationMs data`;

export const LISTAR_BOLETOS = `query ListBoletos { listBoletos(limit: 50) { items { ${CAMPOS_BOLETO} } } }`;
export const LISTAR_EVENTOS = `query ListEvents($boletoId: ID!) { listEvents(boletoId: $boletoId) { items { ${CAMPOS_EVENTO} } } }`;
export const AO_MUDAR_BOLETO = `subscription OnBoletoChanged { onBoletoChanged { ${CAMPOS_BOLETO} } }`;
export const AO_CHEGAR_EVENTO = `subscription OnEvent { onEvent { ${CAMPOS_EVENTO} } }`;
