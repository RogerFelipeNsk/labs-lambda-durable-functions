// A linha do tempo mora na mesma particao do boleto, com sk = EVT#<seq>.
// begins_with mantem a leitura barata e ja devolve na ordem cronologica.
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  return {
    operation: "Query",
    query: {
      expression: "#pk = :pk AND begins_with(#sk, :sk)",
      expressionNames: { "#pk": "pk", "#sk": "sk" },
      expressionValues: util.dynamodb.toMapValues({
        ":pk": `BOLETO#${ctx.args.boletoId}`,
        ":sk": "EVT#",
      }),
    },
    scanIndexForward: true,
    limit: ctx.args.limit ?? 200,
    nextToken: ctx.args.nextToken,
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return { items: ctx.result.items, nextToken: ctx.result.nextToken };
}
