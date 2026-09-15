// Lista os boletos do mais novo para o mais antigo pelo indice by_created.
// Nunca um Scan: gsi1pk e sempre a constante "BOLETO", entao a Query pega
// exatamente a particao que interessa.
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  return {
    operation: "Query",
    index: "by_created",
    query: {
      expression: "#pk = :pk",
      expressionNames: { "#pk": "gsi1pk" },
      expressionValues: util.dynamodb.toMapValues({ ":pk": "BOLETO" }),
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
