# Mesa de conciliação — laboratório de AWS Lambda durable functions

Uma aplicação completa em que **o controle do fluxo de negócio mora dentro de uma
Lambda durable function**: emissão do boleto, espera pelo pagamento, baixa,
extrato e conciliação acontecem em uma única execução durável, que pode ficar
suspensa por dias sem consumir compute.

```
  POST /boletos                                       webhook do banco
       │                                                     │
       ▼                                                     ▼
  ┌─────────┐   Invoke (Event)   ┌──────────────────────────────────────┐
  │   API   │ ─────────────────► │        orquestrador (durable)        │
  │ Lambda  │                    │                                      │
  └─────────┘ ◄───────────────── │  step  registrar-emissão             │
       │      SendDurableExecu-  │  ⏸  waitForCallback  aguarda pagto   │
       │      tionCallbackSuccess│  ⏸  wait  compensação interbancária  │
       │                         │  step  dar-baixa  (AtMostOnce)       │
       │                         │  ∥   parallel  extrato ‖ notificação │
       │                         │  step  conciliar                     │
       │                         └──────────────────────────────────────┘
       │                                          │
       ▼                                          ▼
   DynamoDB  ◄──── leitura ────  AppSync  ◄── publish (IAM) ──┘
  (verdade)                     (tempo real)
                                     │ subscription (API key)
                                     ▼
                                React + Vite
```

---

## Por que este cenário

Durable functions não são "Step Functions escrito em código". O que elas
resolvem bem é **fluxo de negócio longo, com estado, escrito como código
sequencial comum**. Uma cobrança tem exatamente esse formato:

| Etapa | Primitiva usada | O que ela demonstra |
|---|---|---|
| Emissão | `ctx.step` | checkpoint simples, com retry automático |
| Aguardar pagamento | `ctx.waitForCallback` | **suspensão real** — dias parada, custo zero |
| Compensação e ritmo | `ctx.wait` | espera por tempo, também suspensa e também grátis |
| Baixa | `ctx.step` + `AtMostOncePerRetry` | efeito colateral financeiro não repetível |
| Extrato + notificação | `ctx.parallel` | ramos independentes, retry isolado por ramo |
| Conciliação | `ctx.step` | resultado do step anterior chega pelo replay |

### As três lições que valem o laboratório

**1. Suspensão é diferente de espera.**
Entre a emissão e o pagamento, a execução não existe em lugar nenhum além do log
de checkpoints. Nenhum worker, nenhuma concorrência reservada, nenhum centavo.
Um `setTimeout` dentro de um handler comum faria o oposto: você pagaria pelo
tempo parado e perderia tudo num cold start.

**2. `AtMostOncePerRetry` sozinho não protege efeito colateral.**
Esta é a pegadinha mais cara do recurso, e ela foi descoberta testando este lab
na AWS real — não lendo a documentação.

O nome da semântica é literal: *no máximo uma vez **por tentativa***. Quando a
invocação morre no meio do step, o SDK monta um `StepInterruptedError` e
**pergunta à sua política de retry** se deve tentar de novo. Uma política comum
(`createRetryStrategy({ maxAttempts: 4 })`) responde "sim" — e o step executa
outra vez, como tentativa 2, aplicando o efeito colateral em duplicidade.
Exatamente o que `AtMostOncePerRetry` parecia impedir.

O que fecha a garantia é ensinar à política que **interrupção não é retentável**:

```js
const RETRY_BAIXA = (erro, tentativas) => {
  if (erro?.name === "StepInterruptedError") return { shouldRetry: false };
  return retryTransitorio(erro, tentativas);   // falha transitória: retenta normal
};
```

Aí sim o SDK lança `StepError` com `cause.name === "StepInterruptedError"` — que
**não quer dizer "falhou"**, quer dizer *"não sei se deu certo"*. Veja em
[`orchestrator.mjs`](backend/src/orchestrator.mjs) como o fluxo responde com um
step de **conferência**, e não com um retry.

O extrato é o contrário: refazer é inofensivo, então usa a semântica padrão e
uma política de retry bem mais agressiva, sem essa ressalva.

**2b. `ctx.wait` e `setTimeout` parecem a mesma coisa e são opostos.**
Ambos "esperam", mas só um é serverless de verdade:

| | `await ctx.wait({seconds: 30})` | `await new Promise(r => setTimeout(r, 30000))` |
|---|---|---|
| A invocação | **termina** | continua de pé |
| O container | morre | fica alocado |
| Duração cobrada | **zero** | 30 s cheios |
| Concorrência ocupada | nenhuma | uma |
| Ao retomar | nova invocação + replay | nada, nunca parou |

Neste lab as duas aparecem, de propósito e com papéis diferentes. `dormir()`
dentro dos steps representa a latência real de um sistema externo — é tempo que
você pagaria de qualquer jeito, porque a chamada de fato acontece. Já a função
`respirar()` usa `ctx.wait` e existe só para a demonstração ficar legível: é por
isso que dá para colocar 15 segundos entre as etapas sem pensar no custo.

**3. Replay exige determinismo.**
Quando a execução retoma, este arquivo roda **do começo outra vez**. Steps já
concluídos não executam — o SDK devolve o valor gravado. Logo, tudo que estiver
*fora* de um step precisa dar o mesmo resultado em toda execução. É por isso que
`nossoNumero`, comprovante, id do extrato e id da conciliação derivam do id do
boleto, e não de `Math.random()` ou `Date.now()`.

---

## O que sobe na AWS

| Recurso | Papel |
|---|---|
| `aws_lambda_function.orquestrador` | a durable function, com `durable_config` |
| `aws_lambda_alias.orquestrador` | ARN qualificado — durable functions exigem |
| `aws_lambda_function.api` | Lambda comum, fronteira HTTP |
| `aws_apigatewayv2_api` | API HTTP com CORS para o Vite local |
| `aws_dynamodb_table` | tabela única: boleto + linha do tempo |
| `aws_appsync_graphql_api` | canal de tempo real (API key p/ ler, IAM p/ publicar) |

Custo em repouso: praticamente zero. Tudo é sob demanda e o laboratório não
mantém nada provisionado.

---

## Rodando

### Pré-requisitos

- OpenTofu ≥ 1.9 e **provider AWS ≥ 6.25.0** (antes disso não existe `durable_config`)
- Node.js ≥ 22
- Um perfil AWS numa região com durable functions disponível

Por padrão o deploy usa a cadeia normal de credenciais da AWS e a região
`us-east-2`. Para fixar um perfil ou outra região:

```bash
tofu apply -var perfil_aws=meu-perfil -var regiao=us-east-1
```

ou copie `infra/terraform.tfvars.example` para `infra/terraform.tfvars`.

### Passo a passo

```bash
cd app

# 1. empacota o backend (src + node_modules → dist/backend.zip)
make build

# 2. cria tudo na AWS. Ao final grava frontend/.env.local com os endpoints
make deploy

# 3. sobe a interface
make dev          # http://localhost:5173
```

Sem `make`, é a mesma coisa:

```bash
cd backend  && npm install && npm run build
cd ../infra && tofu init && tofu apply
cd ../frontend && npm install && npm run dev
```

> O `tofu plan` lê `backend/dist/backend.zip` para calcular o hash do código.
> Rode o build **antes** do plan, sempre.

---

## O roteiro do laboratório

### 1. O caminho feliz

Emita uma cobrança. O boleto para em **aguardando pagamento** — e aí é o momento
de olhar a aba *Durable executions* da função no console da AWS (o link sai em
`tofu output console_execucoes_durable`). A execução está `RUNNING`, mas nenhuma
invocação está acontecendo.

Clique em **Registrar pagamento**. Isso chama
`SendDurableExecutionCallbackSuccess` com o `callbackId` que o workflow gravou no
DynamoDB antes de suspender. A partir daí a timeline se completa sozinha, via
subscription — a tela nunca faz polling.

### 2. Retry com backoff

No painel de caos, escolha **Falhar a baixa**, 2 vezes, e arme *antes* de pagar.
Na timeline aparecem as tentativas numeradas, com o intervalo crescendo entre
elas (3s → 6s → 12s, com jitter pela metade). Compare com o histórico da execução
no console: cada tentativa é um registro.

### 3. A lição principal — interrupção no meio do efeito colateral

Há dois modos de derrubada, e a diferença entre eles é o ponto todo.

**a) Derrubar _antes_ de efetivar a baixa** — o dinheiro não se moveu. A
conferência constata isso e refaz com segurança:

```
02:53:40 INFO  baixa  Dando baixa no contas a receber
02:53:43 WARN  baixa  Invocação caiu antes de efetivar a baixa. Conferência
                      confirmou que nada foi aplicado, refazendo.
02:53:45 INFO  baixa  Baixa efetivada, comprovante BXE26AEFE6B8
```

**b) Derrubar _depois_ da baixa, antes do checkpoint** — este é o caso caro. O
efeito já aconteceu, mas o durable não sabe. Um retry cego daria baixa em
duplicidade; a conferência encontra o comprovante e não refaz nada:

```
baixa   WARN  Invocação caiu no meio da baixa, mas a conferência achou o
              comprovante BXE26AEFE6B8. Nada foi refeito.
```

Agora o experimento que ensina de verdade. Em
[`orchestrator.mjs`](backend/src/orchestrator.mjs), comente a linha que recusa a
interrupção:

```js
const RETRY_BAIXA = (erro, tentativas) => {
  // if (erro?.name === "StepInterruptedError") return { shouldRetry: false };
  return retryTransitorio(erro, tentativas);
};
```

`make deploy`, repita o teste — e veja a baixa executar **duas vezes**, mesmo com
`AtMostOncePerRetry` no lugar. A semântica não foi violada: ela promete uma
execução por tentativa, e a política autorizou uma segunda tentativa. Essa é a
diferença entre ler o nome da constante e entender o contrato.

### 4. Ramos paralelos

**Falhar o extrato** derruba só um ramo do `ctx.parallel`. A notificação do ERP
conclui normalmente enquanto o extrato é retentado.

### 5. Divergência de conciliação

**Divergência no extrato** faz o banco reportar um líquido diferente do esperado.
O fluxo termina como `CONCILIADO`, mas com `divergenciaCentavos ≠ 0` e evento em
nível `WARN` — que é como um sistema real encaminharia para tratamento manual.

### 6. Parada e idempotência

`StopDurableExecution` mata a execução sem rodar mais nenhum step — repare que
quem registra o desfecho na timeline passa a ser a API, não o workflow.

> **Todas as rotas exigem o header `x-lab-token`**, exceto `GET /saude`. O token
> é gerado no `apply` e já vai para o `.env.local` do frontend. Para usar no
> terminal:
>
> ```bash
> TOKEN=$(cd infra && tofu output -raw token_api)
> curl -s -H "x-lab-token: $TOKEN" "$API/boletos"
> ```

> **Se for roteirizar com `curl`:** logo após o `POST /boletos` o workflow ainda
> não registrou o callback, e `POST /pagar` responde `409`. Espere o campo
> `callbackId` aparecer em `GET /boletos/{id}` antes de pagar. Na interface isso
> não acontece porque o botão só habilita quando o `callbackId` chega pela
> subscription.

E para ver a idempotência de start funcionando:

```bash
API=$(cd infra && tofu output -raw api_url)
curl -s "$API/boletos" | head -c 400
```

O `DurableExecutionName` é o id do boleto. Reenviar o mesmo `Invoke` com o mesmo
payload devolve a execução existente em vez de abrir uma segunda.

---

## Mapa dos arquivos

```
backend/
  src/orchestrator.mjs      ← a durable function. comece por aqui
  src/api.mjs               ← rotas HTTP: start, callback, stop, get
  src/shared/store.mjs      ← DynamoDB + `avancar()`, o único mutador de estado
  src/shared/appsync.mjs    ← publica no AppSync assinando com SigV4
  src/shared/chaos.mjs      ← injeção de falhas, com orçamento atômico
  src/shared/domain.mjs     ← status, etapas e geração determinística de dados
  scripts/build.mjs         ← empacota src + node_modules (sem bundler, de propósito)

infra/
  lambda.tf                 ← durable_config, publish, alias
  iam.tf                    ← permissões de checkpoint, callback e stop
  appsync.tf                ← duas auth modes, data source NONE para publicar
  schema.graphql            ← @aws_subscribe, @aws_api_key, @aws_iam
  resolvers/*.js            ← runtime APPSYNC_JS

frontend/
  src/App.jsx               ← carga inicial + duas subscriptions
  src/components/           ← pipeline, timeline, painel de caos
```

---

## Segurança

Este é um laboratório, e algumas escolhas refletem isso — vale saber quais antes
de copiar qualquer parte para um sistema de verdade.

**O que está protegido.** A API HTTP não tem autenticação nativa: são 8 rotas
públicas na internet, capazes de criar execuções durable na sua conta. Um
**token compartilhado** gerado no `apply` (`random_password`) fecha o acesso
anônimo — a Lambda confere o header `x-lab-token` com comparação em tempo
constante. Não é IAM nem Cognito, mas o risco real aqui é conta de custo, não
vazamento de dado, e o token resolve isso com atrito quase zero.

**O que é público por desenho.** A API key do AppSync vai para o navegador —
é assim que auth `API_KEY` funciona. Ela só permite **ler e assinar**; publicar
exige IAM e é exclusivo das Lambdas. O padrão está correto para dados fictícios,
mas não sirva dado real por trás de uma API key.

**O que nunca entra no commit.** `terraform.tfstate` (guarda o token e a API key
em claro), `.env.local` e o ZIP do backend estão no `.gitignore`. Nenhum ARN,
ID de conta ou endpoint real aparece no código — tudo vem de
`data.aws_caller_identity` e de outputs.

**O que não é para copiar.** O `process.exit(1)` do painel de caos derruba o
processo de propósito, para provar o comportamento de replay. Está atrás de uma
flag por boleto e existe só para ensinar.

**Antes de deixar de pé.** Se não for usar, `make destroy`. Um endpoint público
com DynamoDB on-demand e Lambda atrás não tem teto de gasto natural.

---

## Pegadinhas que este código já resolve

- **`durable_config` só existe na criação.** Não dá para ligar durable execution
  numa função que já existe; é destroy/create. Decida antes.
- **ARN sem qualificador não invoca.** Por isso `publish = true` e o alias.
- **IAM de durable execution não casa com ARN de função.** As permissões são
  avaliadas contra o ARN da *execução*, que estende o ARN da *versão* — daí o
  `:*` no final do recurso, em [`iam.tf`](infra/iam.tf).
- **Aliases não valem para permissão de execução.** Uma execução iniciada via
  alias carrega o número da versão resolvida no ARN.
- **CORS em dois lugares dá conflito.** O gateway devolve os cabeçalhos; a Lambda
  não devolve nenhum. Duplicar faria o navegador recusar.
- **Tipo devolvido por mutation IAM precisa de `@aws_api_key` também**, senão o
  AppSync entrega o evento para ninguém.
- **`AtMostOncePerRetry` depende da política de retry** — veja a lição 2 acima.
  É a pegadinha mais cara do recurso e não aparece na documentação.
- **Versão do SDK durable importa.** O runtime traz uma cópia, mas o
  `package.json` fixa `@aws/durable-execution-sdk-js` em `2.4.0` e o build a
  empacota: uma troca de major no runtime poderia quebrar execuções em voo.

---

## Derrubando

```bash
make destroy
```

Execuções em andamento morrem junto. Se quiser um encerramento limpo, pare-as
antes pelo painel ou por `StopDurableExecution`.

---

## Referências

- [Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html)
- [Durable Execution SDK](https://docs.aws.amazon.com/durable-execution/)
- [Segurança e permissões](https://docs.aws.amazon.com/lambda/latest/dg/durable-security.html)
- [Idempotência e execution names](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html)
- [Deploy por IaC](https://docs.aws.amazon.com/lambda/latest/dg/durable-getting-started-iac.html)
