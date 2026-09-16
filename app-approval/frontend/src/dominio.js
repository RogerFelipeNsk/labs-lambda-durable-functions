/** Metadados de apresentacao: rotulos, cores e a posicao de cada status no fluxo. */

export const ETAPAS = [
  { chave: "solicitacao", titulo: "Solicitação", detalhe: "registro do pedido" },
  { chave: "aprovacao", titulo: "Aprovação", detalhe: "decisão humana" },
  { chave: "execucao", titulo: "Pagamento", detalhe: "execução financeira" },
];

/** Em que etapa cada status esta, e se a etapa ja passou ou ainda esta rodando. */
const POSICAO = {
  SOLICITADA: [0, "rodando"],
  AGUARDANDO_GESTOR: [1, "esperando"],
  AGUARDANDO_DIRETORIA: [1, "esperando"],
  AGUARDANDO_FINANCEIRO: [1, "esperando"],
  APROVADA: [1, "concluida"],
  EXECUTANDO_PAGAMENTO: [2, "rodando"],
  PAGA: [2, "concluida"],
  REJEITADA: [1, "falhou"],
  EXPIRADA: [1, "falhou"],
  CANCELADA: [-1, "falhou"],
  FALHOU: [-1, "falhou"],
};

export function posicaoDoStatus(status) {
  return POSICAO[status] ?? [0, "rodando"];
}

export const ROTULOS = {
  SOLICITADA: "Solicitada",
  AGUARDANDO_GESTOR: "Aguardando gestor",
  AGUARDANDO_DIRETORIA: "Aguardando diretoria",
  AGUARDANDO_FINANCEIRO: "Aguardando financeiro",
  APROVADA: "Aprovada",
  EXECUTANDO_PAGAMENTO: "Executando pagamento",
  PAGA: "Paga",
  REJEITADA: "Rejeitada",
  EXPIRADA: "Expirada",
  FALHOU: "Falhou",
  CANCELADA: "Cancelada",
};

/** Classe CSS do badge por status. */
export const TOM = {
  SOLICITADA: "neutro",
  AGUARDANDO_GESTOR: "espera",
  AGUARDANDO_DIRETORIA: "espera",
  AGUARDANDO_FINANCEIRO: "espera",
  APROVADA: "info",
  EXECUTANDO_PAGAMENTO: "info",
  PAGA: "sucesso",
  REJEITADA: "erro",
  EXPIRADA: "erro",
  FALHOU: "erro",
  CANCELADA: "erro",
};

/** Papel -> rotulo e a decisao pendente que aquele papel pode tomar. */
export const PAPEIS = [
  { valor: "gestor", titulo: "Gestor", statusEspera: "AGUARDANDO_GESTOR" },
  { valor: "diretoria", titulo: "Diretoria", statusEspera: "AGUARDANDO_DIRETORIA" },
  { valor: "financeiro", titulo: "Financeiro", statusEspera: "AGUARDANDO_FINANCEIRO" },
];

export const MODOS_CAOS = [
  {
    valor: "falhar-pagamento",
    titulo: "Falhar o pagamento",
    explica: "Erro transitório no step de execução do pagamento. Mostra o retry com backoff exponencial e jitter.",
  },
  {
    valor: "derrubar-antes-pagamento",
    titulo: "Derrubar antes de pagar",
    explica:
      "Mata o processo antes do efeito colateral. A conferência constata que nada foi aplicado e refaz com segurança.",
  },
  {
    valor: "derrubar-apos-pagamento",
    titulo: "Derrubar depois de pagar, antes do checkpoint",
    explica:
      "O caso perigoso: o dinheiro já saiu, mas o checkpoint não existe. Um retry cego pagaria em duplicidade. A conferência encontra o comprovante e não refaz nada.",
  },
];

export const emReais = (centavos) =>
  typeof centavos === "number"
    ? (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    : "—";

export const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour12: false }) : "—");

export const dataHora = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { hour12: false }) : "—");

/** Capitaliza a primeira letra — usado para montar nomes de campo a partir
 *  do papel, ex.: papel "gestor" -> campo "callbackIdGestor". Mesma funcao
 *  do backend (shared/domain.mjs), reaproveitada aqui no frontend. */
export const capitalizar = (s) => s.charAt(0).toUpperCase() + s.slice(1);
