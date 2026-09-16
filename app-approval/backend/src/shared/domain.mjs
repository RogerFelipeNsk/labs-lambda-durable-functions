/**
 * Regras de dominio do fluxo de aprovacao de compras. Nada aqui fala com a
 * AWS: sao apenas os estados, os papeis de aprovador e as regras de
 * roteamento por valor.
 *
 * Tudo que e usado dentro de uma durable function precisa ser deterministico
 * quando calculado fora de um step. `decidirRota` e uma funcao pura: dado o
 * mesmo valorCentavos, sempre devolve a mesma rota, em qualquer replay.
 */

/** Estados publicos da solicitacao, na ordem em que aparecem no fluxo feliz. */
export const STATUS = {
  SOLICITADA: "SOLICITADA",
  AGUARDANDO_GESTOR: "AGUARDANDO_GESTOR",
  AGUARDANDO_DIRETORIA: "AGUARDANDO_DIRETORIA",
  AGUARDANDO_FINANCEIRO: "AGUARDANDO_FINANCEIRO",
  APROVADA: "APROVADA",
  EXECUTANDO_PAGAMENTO: "EXECUTANDO_PAGAMENTO",
  PAGA: "PAGA",
  REJEITADA: "REJEITADA",
  EXPIRADA: "EXPIRADA",
  FALHOU: "FALHOU",
  CANCELADA: "CANCELADA",
};

/** Etapas do workflow, usadas para agrupar a timeline no frontend. */
export const STAGE = {
  SOLICITACAO: "solicitacao",
  APROVACAO: "aprovacao",
  EXECUCAO: "execucao",
  FIM: "fim",
};

export const STATUS_TERMINAIS = new Set([
  STATUS.PAGA,
  STATUS.REJEITADA,
  STATUS.EXPIRADA,
  STATUS.FALHOU,
  STATUS.CANCELADA,
]);

/** Os tres papeis que podem decidir uma solicitacao. */
export const PAPEIS = {
  GESTOR: "gestor",
  DIRETORIA: "diretoria",
  FINANCEIRO: "financeiro",
};

/**
 * Roteamento de aprovacao por valor. Pura, sem I/O — pode ser chamada fora de
 * um step porque o valor de entrada (valorCentavos) ja veio de um checkpoint
 * anterior, e a funcao sempre devolve o mesmo resultado para o mesmo valor.
 *
 * - Abaixo do limite automatico: aprovacao automatica, sem passar por humano.
 * - Entre os limites: so o gestor decide (com escalonamento para diretoria
 *   se ele nao responder no prazo).
 * - Acima do limite financeiro: gestor E financeiro decidem em paralelo.
 */
export function decidirRota(valorCentavos, limiteAutomaticoCentavos, limiteFinanceiroCentavos) {
  return {
    autoAprovar: valorCentavos < limiteAutomaticoCentavos,
    precisaFinanceiro: valorCentavos >= limiteFinanceiroCentavos,
  };
}

/** Identificadores derivados da solicitacao, estaveis entre replays. */
export const comprovantePagamento = (id) => `PAG${id.replace(/-/g, "").slice(0, 10).toUpperCase()}`;

export const formatarBRL = (centavos) =>
  (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** Pausa simples para simular latencia de sistema externo dentro de um step. */
export const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Capitaliza a primeira letra — usado para montar nomes de campo a partir do
 * papel, ex.: papel "gestor" -> campo "callbackIdGestor".
 */
export const capitalizar = (s) => s.charAt(0).toUpperCase() + s.slice(1);
