# Relatório de custos — Mesa de aprovações

**Data:** 16/09/2026 · **Região:** us-east-2 (Ohio) · **Base:** 6 execuções reais medidas no lab, lidas direto da AWS

Este relatório é o par do [relatório de custos do boleto](custo-durable-functions.md),
aplicado ao segundo laboratório (`app-approval/`). A metodologia e os preços
são os mesmos — validados naquele relatório contra o exemplo oficial da AWS
ao centavo. O que muda aqui são os **dados**: seis execuções reais desta
Lambda, lidas via `GetDurableExecutionHistory` e cruzadas com métricas
oficiais do CloudWatch, cobrindo os três caminhos de roteamento e dois
caminhos de exceção (falha técnica do financeiro e um modo do painel de
caos).

AppSync, DynamoDB, API Gateway e CloudWatch Logs seguem exatamente as mesmas
fórmulas e preços unitários do relatório anterior — só os **volumes** foram
remedidos, porque o fluxo de aprovação gera uma contagem de eventos diferente
da do boleto.

---

## Resumo

| | Automática | Gestor simples | Paralelo (gestor+financeiro) |
|---|---|---|---|
| Operações duráveis | 6 | 11 | 18 |
| Invocações Lambda | 2 | 3 | 4 |
| Custo durable (sem free tier) | USD 0,000066 | USD 0,000114 | USD 0,000179 |

**10.000 solicitações/mês** (mix de 50% automática / 35% gestor / 15%
paralelo, documentado na seção 5):

| | Com free tier | Sem free tier |
|---|---|---|
| **Durable functions** | **USD 0,77** | **USD 1,00** |
| **Stack completo** | **USD 1,59** | **USD 1,82** |

Para comparação, o boleto (todas as execuções idênticas, 18 operações fixas)
saiu em USD 3,19 / 3,79 para o mesmo volume. A diferença não é o preço — é
que **aqui a maioria das execuções é barata**: metade do tráfego nem chega a
abrir um callback.

---

## 1. As seis execuções

Todas na versão 1 do orquestrador, lidas via `GetDurableExecutionHistory`
(script [`scripts/historico.mjs`](../../app-approval/backend/scripts/historico.mjs))
e cruzadas com `GetDurableExecution` para status e resultado final.

| Cenário | Valor | Operações | Bytes gravados | Invocações | Desfecho |
|---|---|---|---|---|---|
| Automática | R$ 200 | 6 | 211 B | 2 | `PAGA` |
| Gestor simples (via curl) | R$ 1.500 | 11 | 380 B | 3 | `PAGA` |
| Gestor simples (via UI, você mesmo) | R$ 550 | 11 | 319 B | 3 | `PAGA` |
| Paralelo gestor+financeiro | R$ 8.000 | 18 | 738 B | 4 | `PAGA` |
| Falha técnica do financeiro | R$ 6.000 | 15 | 593 B | 3 | `PAGA` — a *execução*, não a solicitação: ela terminou `SUCCEEDED`, o resultado de negócio é que foi rejeitado |
| Caos: derruba após pagamento | R$ 250 | 7 | 228 B | 3 | `PAGA`, com conferência não-refazendo |

A execução "via UI" não foi um teste roteirizado: é uma solicitação de
R$ 550 que alguém aprovou clicando na própria tela, com ~25 segundos reais
entre o callback abrir e a decisão chegar — a suspensão de verdade
acontecendo, não simulada.

---

## 2. Duas correções de método descobertas nesta medição

A primeira vez que fiz esse tipo de medição (relatório do boleto), o método
funcionou de primeira. Desta vez, duas contagens que eu supunha óbvias
estavam erradas — e valem registro porque provavelmente vão errar de novo
para qualquer um que tente reproduzir isto.

### `InvocationCompleted` conta a invocação final também

Eu assumia que o evento `InvocationCompleted` só aparece quando a execução
**suspende** (e portanto `invocações = InvocationCompleted + 1`, contando a
invocação final que não suspende). Falso: ele aparece em **toda** invocação,
inclusive a última — no histórico do cenário paralelo,
`InvocationCompleted` e `ExecutionSucceeded` têm o mesmo timestamp, o mesmo
`EventId` consecutivo. A contagem certa é `invocações = InvocationCompleted`,
sem ajuste. Confirmado batendo a soma das 6 execuções (18 invocações) contra
a contagem de linhas `REPORT` nos logs do CloudWatch no mesmo intervalo: 18
contra 18, exato.

### As métricas de tempo real do AppSync exigem um assinante conectado

Tentei validar a contagem de mutations com `PublishDataMessageSuccess`,
`InboundMessageSuccess` e `OutboundMessages` — a mesma combinação que bateu
exata (24=24) no relatório do boleto. Aqui deu **18** contra uma previsão de
~100 pela fórmula. A diferença: no teste do boleto eu tinha o navegador
aberto, com uma subscription ativa, quando fiz a medição. Neste laboratório,
os seis cenários rodaram só via `curl` — nenhum assinante jamais conectou.

Essas três métricas são do **canal WebSocket de tempo real**: contam mensagem
entregue a um assinante, não a mutation em si. Sem assinante, não há o que
entregar, e ficam quase zeradas independente de quantas mutations aconteceram.
A métrica correta para o volume de requisições GraphQL (o que a AWS
efetivamente cobra como "Query and Data Modification Operations") é
`Latency`, olhando `SampleCount` em vez de `Sum` — ela conta toda requisição
que chega ao AppSync, com ou sem assinante. Essa bateu: **108** contra
**100** previstos pela fórmula (1 criação + 1 atualização de `executionArn` +
2 por evento de timeline), 8% de diferença, dentro do esperado.

**A lição:** para medir volume de mutations de um backend que publica em
AppSync, meça com `Latency`, não com as métricas de mensagem do canal —
essas dependem de haver alguém ouvindo.

---

## 3. Validação agregada — por que não por cenário isolado

A primeira tentativa foi isolar cada cenário numa janela estreita do
CloudWatch, como funcionou no relatório do boleto. Não funcionou aqui: os
seis cenários rodaram em sequência rápida (menos de 4 minutos entre o
primeiro e o quinto), e as métricas `DurableExecutionOperations` e
`DurableExecutionStorageWrittenBytes` **não têm dimensão por execução** — só
por função, versão e alias. Uma janela de tempo que cobre parte de uma
execução inevitavelmente também cobre parte da vizinha, e o resultado por
cenário isolado saiu incoerente (uma tentativa chegou a mostrar *menos*
operações do que o histórico confirmava, outra *mais*).

A correção: em vez de isolar cada cenário, somei o previsto pelas seis
leituras de `GetDurableExecutionHistory` (que é escopado por execução — sem
ambiguidade) e comparei com o CloudWatch **agregado** sobre a janela inteira.

| Métrica | Soma manual (5 cenários do bloco) | CloudWatch agregado | Diferença |
|---|---|---|---|
| Operações duráveis | 57 | 58 | 1,8% |
| Bytes gravados | 2.150 B | 2.212 B | 2,9% |
| Requisições AppSync (`Latency`) | 100 | 108 | 8,0% |
| Invocações Lambda | 18 | 18 (linhas `REPORT`) | exato |

Dentro do esperado para arredondamento e pequenos custos de metadado que os
payloads brutos não capturam — a mesma faixa de diferença observada no
relatório do boleto. **A fonte confiável para o detalhe por cenário é
`GetDurableExecutionHistory`; o CloudWatch serve para validar o agregado, não
para isolar uma execução específica quando várias rodam perto no tempo.**

---

## 4. Custo por cenário

Compute estimado a partir da média medida de **1.288,8 ms faturados por
invocação** (23.199 ms somados ÷ 18 invocações, todas as seis execuções).

| Cenário | Operações | Bytes | Invocações | Compute estimado | Custo durable (sem free tier) |
|---|---|---|---|---|---|
| Automática | 6 | 211 B | 2 | 2.578 ms | USD 0,000066 |
| Gestor simples | 11 | ~350 B | 3 | 3.867 ms | USD 0,000114 |
| Paralelo | 18 | 738 B | 4 | 5.155 ms | USD 0,000179 |
| Falha técnica financeiro | 15 | 593 B | 3 | 3.867 ms | USD 0,000147 |
| Caos: retomada após crash | 7 | 228 B | 3 | 3.867 ms | USD 0,000082 |

O padrão que mais importa: **operações dominam, igual no boleto** — o custo
sobe com o número de `step`/`wait`/`callback`/`context` que o fluxo abre, não
com o tempo de relógio. O cenário paralelo custa 2,7× mais que o automático
principalmente porque abre 3× mais operações (18 contra 6), não porque leva
mais tempo de compute.

---

## 5. Projeção: 10.000 solicitações/mês

Ao contrário do boleto — onde toda execução passa pelas mesmas cinco etapas
— aqui o custo depende de **qual caminho de aprovação cada solicitação
toma**, decidido pelo valor. A projeção exige uma suposição de mix, que este
relatório declara explicitamente (ajuste para o seu caso real trocando os
pesos):

| Rota | Peso assumido | Operações | Eventos de timeline | Invocações |
|---|---|---|---|---|
| Automática (< R$ 300) | 50% | 6 | 5 | 2 |
| Gestor simples (R$ 300 – R$ 5.000) | 35% | 11 | 8 | 3 |
| Paralelo (≥ R$ 5.000) | 15% | 18 | 10 | 4 |

Isso não inclui escalonamento (gestor não responde → diretoria) nem falha
técnica do financeiro — ambos são caminhos de exceção, tratados à parte na
seção 6.

### Volumes projetados

```
Operações duráveis   10.000 × (0,50×6 + 0,35×11 + 0,15×18)     =  95.500
Bytes gravados        (ponderado pelos mesmos pesos)            ≈ 3,39 MB
Invocações Lambda     10.000 × (0,50×2 + 0,35×3 + 0,15×4)       =  26.500
Escritas DynamoDB     10.000 × (2 + eventos×2, ponderado)       = 156.000
Requisições AppSync    igual às escritas — 1 mutation por escrita = 156.000
```

### Custo

| Linha | Com free tier | Sem free tier |
|---|---|---|
| Durable functions — compute | USD 0,00 *(free tier)* | USD 0,23 |
| Durable functions — requests | USD 0,00 *(free tier)* | USD 0,01 |
| Durable functions — operações | USD 0,76 | USD 0,76 |
| Durable functions — dados + retenção | USD 0,0008 | USD 0,0008 |
| **Subtotal durable** | **USD 0,77** | **USD 1,00** |
| DynamoDB — escritas (WRU medido ×1,30 pelo arredondamento de item) | USD 0,13 | USD 0,13 |
| DynamoDB — leituras | USD 0,01 | USD 0,01 |
| AppSync — requisições (`Latency`, medida) | USD 0,62 | USD 0,62 |
| API Gateway HTTP | USD 0,03 | USD 0,03 |
| CloudWatch Logs — ingestão | USD 0,04 | USD 0,04 |
| **TOTAL** | **USD 1,59** | **USD 1,82** |

O fator de correção do DynamoDB (**×1,30**) vem medido, não presumido: 130
WCU consumidos para ~100 escritas previstas pela fórmula, na mesma
proporção do fenômeno já documentado no relatório do boleto — itens de
solicitação acima de 1 KB custam 2 WRU por escrita, não 1.

---

## 6. Custo dos caminhos de exceção

Não entram na projeção de volume (são desvios do caminho feliz), mas valem
como referência de "quanto custa uma solicitação que dá errado":

| Caminho | Operações extras vs. equivalente sem erro | Custo por ocorrência |
|---|---|---|
| Falha técnica do financeiro | +4 (comparado a um paralelo que os dois aprovam de primeira: a rejeição fecha mais cedo, mas o `CallbackExternalError` e o step de registro somam) | USD 0,000147 |
| Caos: crash antes do checkpoint do pagamento | +1 step de conferência | +USD 0,000008 sobre o custo normal |
| Escalonamento (gestor → diretoria) | +1 contexto, +1 callback, +1 step de registro — não medido nesta sessão (prazo padrão de 24h é inviável de esperar ao vivo) | estimado ~USD 0,00006 adicional, pela mesma lógica de +7 operações |

O escalonamento é o único cenário deste relatório que **não** vem de uma
execução real — os prazos padrão (`prazo_gestor_minutos = 1440`) tornam
inviável esperar 24h numa sessão de trabalho. A estimativa usa a mesma
fórmula das demais linhas, aplicada às operações que o código
(`fluxoAprovacaoComEscalonamento` em
[`orchestrator.mjs`](../../app-approval/backend/src/orchestrator.mjs))
declara abrir nesse caminho, sem medição direta.

---

## 7. Comparando com o boleto

| | Boleto (`app/`) | Aprovação (`app-approval/`) |
|---|---|---|
| Operações por execução | Fixo em 18, sempre | Varia de 6 a 18, conforme a rota |
| Callbacks por execução | 1, sempre | 0, 1 ou 2 (em paralelo) |
| Custo durable, 10k/mês (sem free tier) | USD 2,04 | USD 1,00 |
| Stack completo, 10k/mês (sem free tier) | USD 3,79 | USD 1,82 |

A aprovação sai mais barata no agregado **apesar de** ter um fluxo mais
complexo (roteamento condicional, escalonamento, paralelismo) — porque metade
das solicitações, pelo mix assumido, nunca abre um callback. É o oposto do
que a complexidade do código sugeriria à primeira vista, e é exatamente o
tipo de coisa que só aparece medindo: **a estrutura do código não prevê o
custo agregado sozinha — a distribuição do tráfego pelas rotas importa tanto
quanto o código de cada rota.**

---

## 8. Ressalvas

- **Amostra pequena.** Seis execuções, cinco delas em menos de 4 minutos.
  Suficiente para validar a metodologia e capturar os números exatos de cada
  caminho de código, insuficiente para capturar variação real de payload
  (nomes de solicitante mais longos, comentários de aprovação mais extensos
  mudam os bytes gravados).
- **O mix de 50/35/15 é uma suposição**, não um dado observado — não há
  histórico de produção para calibrar. Ajuste os pesos na seção 5 para o seu
  caso.
- **Escalonamento não foi medido ao vivo**, só estimado por leitura de
  código. Para medir de verdade, redeploy com `prazo_gestor_minutos = 1` e
  deixe uma solicitação vencer sem decisão.
- **Free tier por conta**, mesma ressalva do relatório do boleto: os 400.000
  GB-s e 1 milhão de requests são compartilhados com tudo que roda na conta.
- **Preços mudam.** Confira em [aws.amazon.com/lambda/pricing](https://aws.amazon.com/lambda/pricing/),
  [appsync/pricing](https://aws.amazon.com/appsync/pricing/) e
  [dynamodb/pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/).
- **Não inclui:** transferência de dados, CloudTrail data events, e o custo
  de hospedar o frontend (roda local neste lab).

---

## Como reproduzir

```bash
cd app-approval/infra
export AWS_PROFILE=meu-perfil
FN=$(tofu output -raw nome_funcao_orquestrador)
TABELA=$(tofu output -raw tabela_solicitacoes)

# Histórico exato de uma execução — a fonte confiável por cenário
cd ../backend
node scripts/historico.mjs "<url do console>" historico.json

# Validação agregada — NUNCA isole uma execução por janela de tempo se houver
# outras rodando perto; some o histórico de todas e compare com o agregado.
INICIO=2026-01-01T00:00:00Z; FIM=2026-01-01T01:00:00Z
for M in DurableExecutionOperations DurableExecutionStorageWrittenBytes; do
  aws cloudwatch get-metric-statistics --region us-east-2 \
    --namespace AWS/Lambda --metric-name "$M" \
    --dimensions Name=FunctionName,Value="$FN" \
    --start-time "$INICIO" --end-time "$FIM" --period 3600 \
    --statistics Sum --query 'Datapoints[].Sum' --output text
done

# Compute faturado, por invocação
aws logs filter-log-events --region us-east-2 --log-group-name "/aws/lambda/$FN" \
  --filter-pattern '{ $.type = "platform.report" }'

# DynamoDB — WCU real, para calibrar o fator de arredondamento por item
aws cloudwatch get-metric-statistics --region us-east-2 \
  --namespace AWS/DynamoDB --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value="$TABELA" \
  --start-time "$INICIO" --end-time "$FIM" --period 3600 \
  --statistics Sum --query 'Datapoints[].Sum' --output text

# AppSync — use Latency (SampleCount), NÃO as métricas de mensagem em tempo
# real (essas exigem um assinante conectado)
APPSYNC_ID=$(aws appsync list-graphql-apis --region us-east-2 \
  --query "graphqlApis[?name=='lab-aprovacao-api'].apiId" --output text)
aws cloudwatch get-metric-statistics --region us-east-2 \
  --namespace AWS/AppSync --metric-name Latency \
  --dimensions Name=GraphQLAPIId,Value="$APPSYNC_ID" \
  --start-time "$INICIO" --end-time "$FIM" --period 3600 \
  --statistics SampleCount --query 'Datapoints[].SampleCount' --output text
```
