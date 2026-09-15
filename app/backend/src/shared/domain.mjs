/**
 * Regras de dominio do fluxo de cobranca. Nada aqui fala com a AWS: sao
 * apenas os estados, os estagios e a geracao de dados do boleto.
 *
 * Tudo que e usado dentro de uma durable function precisa ser deterministico
 * quando calculado fora de um step. Por isso `nossoNumero` e `linhaDigitavel`
 * derivam do id do boleto, e nao de Math.random() ou Date.now().
 */

/** Estados publicos do boleto, na ordem em que aparecem no fluxo feliz. */
export const STATUS = {
  EMITIDO: "EMITIDO",
  AGUARDANDO_PAGAMENTO: "AGUARDANDO_PAGAMENTO",
  PAGO: "PAGO",
  BAIXANDO: "BAIXANDO",
  BAIXADO: "BAIXADO",
  GERANDO_EXTRATO: "GERANDO_EXTRATO",
  EXTRATO_GERADO: "EXTRATO_GERADO",
  CONCILIANDO: "CONCILIANDO",
  CONCILIADO: "CONCILIADO",
  EXPIRADO: "EXPIRADO",
  FALHOU: "FALHOU",
  CANCELADO: "CANCELADO",
};

/** Etapas do workflow, usadas para agrupar a timeline no frontend. */
export const STAGE = {
  EMISSAO: "emissao",
  PAGAMENTO: "pagamento",
  BAIXA: "baixa",
  EXTRATO: "extrato",
  CONCILIACAO: "conciliacao",
  FIM: "fim",
};

export const STATUS_TERMINAIS = new Set([
  STATUS.CONCILIADO,
  STATUS.EXPIRADO,
  STATUS.FALHOU,
  STATUS.CANCELADO,
]);

/** Soma dos digitos de uma string, usada para gerar numeros estaveis por id. */
function hashNumerico(texto, modulo) {
  let acc = 0;
  for (let i = 0; i < texto.length; i += 1) {
    acc = (acc * 31 + texto.charCodeAt(i)) % modulo;
  }
  return acc;
}

/**
 * Gera os dados bancarios ficticios do boleto a partir do id.
 * Deterministico de proposito: se a durable function fizer replay, o mesmo
 * boleto produz exatamente os mesmos numeros.
 */
export function dadosBancarios(boletoId) {
  const base = boletoId.replace(/-/g, "");
  const nossoNumero = String(hashNumerico(base, 10 ** 11)).padStart(11, "0");
  const blocos = [];
  for (let i = 0; i < 5; i += 1) {
    blocos.push(String(hashNumerico(`${base}:${i}`, 10 ** 9)).padStart(9, "0"));
  }
  const linhaDigitavel = [
    `${blocos[0].slice(0, 5)}.${blocos[0].slice(5)}`,
    `${blocos[1].slice(0, 5)}.${blocos[1].slice(5)}`,
    `${blocos[2].slice(0, 5)}.${blocos[2].slice(5)}`,
    blocos[3].slice(0, 1),
    blocos[4].slice(0, 8),
  ].join(" ");
  return { nossoNumero, linhaDigitavel };
}

/** Identificadores derivados do boleto, estaveis entre replays. */
export const comprovanteBaixa = (boletoId) => `BX${boletoId.replace(/-/g, "").slice(0, 10).toUpperCase()}`;
export const idExtrato = (boletoId) => `EXT${boletoId.replace(/-/g, "").slice(0, 10).toUpperCase()}`;
export const idConciliacao = (boletoId) => `CON${boletoId.replace(/-/g, "").slice(0, 10).toUpperCase()}`;

export const formatarBRL = (centavos) =>
  (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Tarifa bancaria simulada, cobrada na liquidacao. E ela que cria a
 * "divergencia" que a etapa de conciliacao precisa explicar: o extrato mostra
 * o valor liquido, o contas a receber espera o valor bruto.
 */
export const TARIFA_LIQUIDACAO_CENTAVOS = 349;

/**
 * Pausa dentro de um step, para simular a latencia de um sistema externo.
 *
 * ATENCAO: isto e um setTimeout comum. A Lambda fica DE PE e o tempo E
 * COBRADO como duracao de execucao. E o certo aqui, porque representa uma
 * chamada real a um banco que de fato demoraria isso.
 *
 * Para pausas que existem so para a demonstracao ficar legivel, use
 * `ctx.wait` (veja `respirar` no orchestrator): aquilo suspende a execucao
 * e nao custa compute.
 */
export const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
