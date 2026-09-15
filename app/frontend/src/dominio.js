/** Metadados de apresentacao: rotulos, cores e a posicao de cada status no fluxo. */

export const ETAPAS = [
  { chave: "emissao", titulo: "Emissão", detalhe: "registro no banco" },
  { chave: "pagamento", titulo: "Pagamento", detalhe: "execução suspensa" },
  { chave: "baixa", titulo: "Baixa", detalhe: "contas a receber" },
  { chave: "extrato", titulo: "Extrato", detalhe: "ramo paralelo" },
  { chave: "conciliacao", titulo: "Conciliação", detalhe: "fechamento" },
];

/** Em que etapa cada status esta, e se a etapa ja passou ou ainda esta rodando. */
const POSICAO = {
  EMITIDO: [0, "rodando"],
  AGUARDANDO_PAGAMENTO: [1, "esperando"],
  PAGO: [1, "concluida"],
  BAIXANDO: [2, "rodando"],
  BAIXADO: [2, "concluida"],
  GERANDO_EXTRATO: [3, "rodando"],
  EXTRATO_GERADO: [3, "concluida"],
  CONCILIANDO: [4, "rodando"],
  CONCILIADO: [4, "concluida"],
  EXPIRADO: [1, "falhou"],
  CANCELADO: [-1, "falhou"],
  FALHOU: [-1, "falhou"],
};

export function posicaoDoStatus(status) {
  return POSICAO[status] ?? [0, "rodando"];
}

export const ROTULOS = {
  EMITIDO: "Emitido",
  AGUARDANDO_PAGAMENTO: "Aguardando pagamento",
  PAGO: "Pago",
  BAIXANDO: "Dando baixa",
  BAIXADO: "Baixado",
  GERANDO_EXTRATO: "Gerando extrato",
  EXTRATO_GERADO: "Extrato gerado",
  CONCILIANDO: "Conciliando",
  CONCILIADO: "Conciliado",
  EXPIRADO: "Vencido",
  CANCELADO: "Cancelado",
  FALHOU: "Falhou",
};

/** Classe CSS do badge por status. */
export const TOM = {
  EMITIDO: "neutro",
  AGUARDANDO_PAGAMENTO: "espera",
  PAGO: "info",
  BAIXANDO: "info",
  BAIXADO: "info",
  GERANDO_EXTRATO: "info",
  EXTRATO_GERADO: "info",
  CONCILIANDO: "info",
  CONCILIADO: "sucesso",
  EXPIRADO: "erro",
  CANCELADO: "erro",
  FALHOU: "erro",
};

export const MODOS_CAOS = [
  {
    valor: "falhar-baixa",
    titulo: "Falhar a baixa",
    explica: "Erro transitório no step da baixa. Mostra o retry com backoff exponencial e jitter.",
  },
  {
    valor: "derrubar-antes-baixa",
    titulo: "Derrubar antes de efetivar a baixa",
    explica:
      "Mata o processo antes do efeito colateral. A conferência constata que nada foi aplicado e refaz com segurança.",
  },
  {
    valor: "derrubar-apos-baixa",
    titulo: "Derrubar depois da baixa, antes do checkpoint",
    explica:
      "O caso perigoso: o dinheiro já se moveu, mas o checkpoint não existe. Um retry cego daria baixa em duplicidade. A conferência encontra o comprovante e não refaz nada.",
  },
  {
    valor: "falhar-extrato",
    titulo: "Falhar o extrato",
    explica: "Erro no ramo paralelo. O outro ramo (notificação do ERP) continua sem ser afetado.",
  },
  {
    valor: "divergencia",
    titulo: "Divergência no extrato",
    explica: "O banco reporta um líquido diferente do esperado e a conciliação fecha com divergência.",
  },
];

export const emReais = (centavos) =>
  typeof centavos === "number"
    ? (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    : "—";

export const hora = (iso) =>
  iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour12: false }) : "—";

export const dataHora = (iso) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { hour12: false }) : "—";
