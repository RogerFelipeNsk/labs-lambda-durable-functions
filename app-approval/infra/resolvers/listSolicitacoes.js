// Lista as solicitacoes da mais nova para a mais antiga pelo indice
// by_created. Nunca um Scan: gsi1pk e sempre a constante "SOLICITACAO".
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  return {
    operation: "Query",
    index: "by_created",
    query: {
      expression: "#pk = :pk",
      expressionNames: { "#pk": "gsi1pk" },
      expressionValues: util.dynamodb.toMapValues({ ":pk": "SOLICITACAO" }),
    },
    scanIndexForward: false,
    limit: ctx.args.limit ?? 50,
    nextToken: ctx.args.nextToken,
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return { items: ctx.result.items, nextToken: ctx.result.nextToken };
}
