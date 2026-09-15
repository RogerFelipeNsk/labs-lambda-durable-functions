// Resolver local (data source NONE): nao toca em banco nenhum.
// Devolve o payload recebido, e esse retorno e o que o AppSync entrega para
// todo mundo que estiver assinando a subscription correspondente.
export function request(ctx) {
  return { payload: ctx.args.input };
}

export function response(ctx) {
  return ctx.result;
}
