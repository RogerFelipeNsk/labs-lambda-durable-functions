/**
 * Baixa o historico completo de uma durable execution.
 *
 * Aceita a URL que voce copia da barra do console da AWS, monta o ARN da
 * execucao a partir dela e pagina o GetDurableExecutionHistory ate o fim.
 *
 * Existe porque o AWS CLI v2 ainda nao traz os comandos de durable execution:
 * `aws lambda get-durable-execution-history` responde "Invalid choice". O SDK
 * JS ja tem, e ele esta empacotado aqui.
 *
 * Uso:
 *   node scripts/historico.mjs "<url do console>" [saida.json]
 *
 * Lembre que o historico vive apenas pelo `retention_period` configurado na
 * funcao (7 dias neste lab). Passado o prazo, a execucao nao e recuperavel.
 */
import { writeFileSync } from "node:fs";
import {
  GetDurableExecutionCommand,
  GetDurableExecutionHistoryCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { execFileSync } from "node:child_process";

const url = process.argv[2];
const saida = process.argv[3] ?? "historico.json";

// .../functions/<nome>/versions/<versao>/executions/<nome-execucao>/<id-execucao>
const m = url.match(/functions\/([^/]+)\/versions\/([^/]+)\/executions\/([^/]+)\/([^/?#]+)/);
if (!m) throw new Error("URL do console não reconhecida");
const [, funcao, versao, nomeExec, idExec] = m;
const regiao = url.match(/region=([a-z0-9-]+)/)?.[1] ?? "us-east-2";

// A conta vem do CLI para nao precisar de mais uma dependencia no pacote.
const Account = execFileSync("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"])
  .toString().trim();

const arn = `arn:aws:lambda:${regiao}:${Account}:function:${funcao}:${versao}/durable-execution/${nomeExec}/${idExec}`;
console.log("ARN montado:\n  " + arn + "\n");

const lambda = new LambdaClient({ region: regiao });
const exec = await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: arn, IncludeExecutionData: true }));

let marker, eventos = [];
do {
  const h = await lambda.send(new GetDurableExecutionHistoryCommand({
    DurableExecutionArn: arn, IncludeExecutionData: true, Marker: marker,
  }));
  eventos.push(...(h.Events ?? []));
  marker = h.NextMarker;
} while (marker);

writeFileSync(saida, JSON.stringify({ execucao: exec, eventos }, null, 2));

console.log(`Status:  ${exec.Status}`);
console.log(`Versão:  ${exec.Version}`);
console.log(`Início:  ${exec.StartTimestamp?.toISOString?.() ?? exec.StartTimestamp}`);
console.log(`Fim:     ${exec.EndTimestamp?.toISOString?.() ?? exec.EndTimestamp ?? "—"}`);
console.log(`Entrada: ${exec.InputPayload ?? "—"}`);
console.log(`Eventos: ${eventos.length}`);
console.log(`\nSalvo em ${saida}`);
