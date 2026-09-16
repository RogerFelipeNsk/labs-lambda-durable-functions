# Relatório de custos — Lambda durable functions

**Data:** 15/09/2026 · **Região:** us-east-2 (Ohio) · **Base:** execução real medida no lab

Este relatório aplica o modelo de preço de durable functions ao ambiente de
cobrança deste repositório e projeta o custo de **10.000 boletos por mês**.

Os números do nosso fluxo **não são estimativa**: vieram de uma execução real
(`823db927-976d-4b9c-961e-7ce167c72638`, versão 5), lida via
`GetDurableExecutionHistory`, dos registros `platform.report` no CloudWatch, e
de uma segunda rodada com as métricas oficiais de billing — isolando essa
mesma execução numa janela sem outro tráfego para ler
`DurableExecutionOperations`, `DurableExecutionStorageWrittenBytes`,
`DurableExecutionDuration`, `ConsumedWriteCapacityUnits` do DynamoDB e
`PublishDataMessageSuccess` do AppSync diretamente do CloudWatch. As duas
rodadas bateram entre si; uma delas corrigiu o relatório, e está marcada onde
acontece.

---

## Resumo

**10.000 boletos/mês:**

| | Com free tier | Sem free tier |
|---|---|---|
| **Durable functions** | **USD 1,44** | **USD 2,04** |
| **Stack completo** (+ AppSync, DynamoDB, API Gateway, Logs) | **USD 3,19** | **USD 3,79** |
| Por boleto | USD 0,000319 | USD 0,000379 |
| Por mil boletos | USD 0,32 | USD 0,38 |

O free tier de Lambda (400.000 GB-s e 1 milhão de requests por mês) é
**permanente**, mas é **por conta** — compartilhado com todas as outras funções.
A coluna "sem free tier" é o cenário realista para uma conta que já roda outras
coisas, e é ela que você deve usar para projetar.

A conclusão que importa: **99% do custo de durable functions do nosso fluxo são
as operações**, não o compute. Isso é o oposto do exemplo oficial da AWS, e a
razão está explicada na [seção 6](#6-o-que-domina-o-custo-e-por-quê).

---

## 1. Como durable functions são cobradas

São cinco linhas, e as três últimas só existem por causa do durable:

| Linha | Preço (us-east-2) | O que mede |
|---|---|---|
| Compute Lambda | USD 0,0000133334 / GB-s (arm64) | tempo de execução, **incluindo replays** |
| Requests Lambda | USD 0,20 / milhão | cada invocação, inclusive as retomadas |
| **Operações duráveis** | **USD 8,00 / milhão** | início de execução, step, wait, callback, contexto |
| **Dados gravados** | **USD 0,25 / GB** | payload de entrada e resultados dos checkpoints |
| **Dados retidos** | **USD 0,15 / GB-mês** | durante a execução **e** no período de retenção |

Free tier mensal: 400.000 GB-s de compute e 1 milhão de requests. É **por conta**,
compartilhado com todas as outras funções — não é um desconto deste workload.

A regra central: durante uma operação de espera a função suspende e **não incorre
em cobrança de duração** até retomar. Você para de pagar por *tempo* e passa a
pagar por *operações e estado*.

---

## 2. Validação do método

Antes de aplicar ao nosso caso, reproduzi o [exemplo oficial da AWS][ex] —
sinistros de seguros, 1 milhão de execuções/mês, 32 s de compute, 1 GB de
memória, espera de 7 dias, retenção de 14 dias, payloads de 8 KB + 3 × 32 KB.

| Linha | Meu cálculo | AWS |
|---|---|---|
| Compute | USD 421,34 | USD 421,34 |
| Requests | USD 0,20 | USD 0,20 |
| Operações | USD 32,00 | USD 32,00 |
| Dados gravados | USD 26,00 | USD 26,00 |
| Retenção | USD 10,92 | USD 10,92 |
| **Total** | **USD 490,46** | **USD 490,46** |

Bate ao centavo nas cinco linhas. O modelo usado daqui para frente é o mesmo.

[ex]: https://aws.amazon.com/lambda/pricing/

---

## 3. O que foi medido no nosso ambiente

**Configuração:** `nodejs22.x`, **512 MB**, **arm64**, retenção de 7 dias.

### Operações duráveis: 18 por boleto

Contadas no histórico real da execução, e depois **confirmadas de forma
independente**: isolei essa mesma execução numa janela de 20 minutos sem
nenhum outro tráfego e li `DurableExecutionOperations` direto do CloudWatch.
Resultado: 18. Bateu exato com a contagem manual — duas fontes diferentes, dois
métodos diferentes, mesmo número.

| Tipo | Qtd | Quais |
|---|---|---|
| Início de execução | 1 | |
| Steps | 9 | `registrar-emissao`, submitter do callback, `confirmar-pagamento`, `dar-baixa`, `iniciar-pos-baixa`, `montar-extrato`, `enviar-notificacao`, `conciliar`, `encerrar` |
| Callback | 1 | `aguardando-pagamento` |
| Waits | 3 | `compensacao-interbancaria`, `ritmo-antes-do-extrato`, `ritmo-antes-da-conciliacao` |
| Contextos | 4 | `aguardando-pagamento`, `pos-baixa`, `gerar-extrato`, `notificar-erp` |
| **Total** | **18** | |

Duas observações que só apareceram por olhar o histórico real:

- **Contextos são operações cobradas.** O `ctx.parallel` gera um contexto para o
  lote e mais um por ramo. Quatro contextos é 22% do total de operações — e não
  há nenhum no exemplo da AWS, que não usa paralelismo.
- **O submitter do `waitForCallback` conta como step.** Ele vira uma operação
  própria, além do callback em si.

### Dados gravados: 896 bytes por boleto

Medido pela métrica **`AWS/Lambda / DurableExecutionStorageWrittenBytes`**, com
a dimensão `ExecutedVersion` isolando uma única execução da versão 5.

A mesma métrica confirmou as **18 operações** contadas à mão no histórico —
`DurableExecutionOperations` devolveu exatamente 18 para essa execução.

Somando os payloads do histórico eu chegava a 1.087 bytes, 21% a mais. A
diferença são exatamente os 191 bytes do payload de `ExecutionSucceeded`: a
métrica de armazenamento **não conta o resultado final da execução**, só o que
os checkpoints intermediários gravam. O payload de entrada continua contando.

Soma dos payloads por checkpoint, para referência:

```
  ExecutionStarted   (payload de entrada)      51 B
  registrar-emissao                            92 B
  aguardando-pagamento (callback + contexto)  242 B
  dar-baixa                                    30 B
  notificar-erp                                38 B
  montar-extrato + contexto                   158 B
  pos-baixa (resultado do lote)               228 B
  conciliar                                    57 B
  ExecutionSucceeded (resultado final)        191 B  ← não entra na métrica
  ────────────────────────────────────────────────
  Soma dos payloads                         1.087 B
  Cobrado como armazenamento                  896 B
```

Para comparar: o exemplo da AWS grava **104 KB** por execução — 116× mais.

### Compute: 8.851 ms faturados, em 5 invocações

Dos registros `platform.report` no CloudWatch:

| Invocação | Duração | Faturado | |
|---|---|---|---|
| 1 | 2.029 ms | 2.420 ms | emissão + registra callback (cold start 390 ms) |
| 2 | 435 ms | 436 ms | confirma pagamento |
| 3 | 1.923 ms | 1.923 ms | baixa |
| 4 | 2.086 ms | 2.087 ms | extrato ‖ notificação |
| 5 | 1.984 ms | 1.985 ms | conciliação + encerramento |
| | | **8.851 ms** | para um fluxo de **28 s de relógio** |

Os ~19 s de diferença são as suspensões. Custaram zero de compute.

**Validado por duas métricas independentes do CloudWatch**, na mesma janela
isolada:

| Métrica | Valor | O que confirma |
|---|---|---|
| `Duration` (Sum, 5 invocações) | 8.457,89 ms | soma das durações reais — a diferença para os 8.851 ms faturados é 393 ms, quase exatamente o cold start de 390 ms medido no `platform.report` (o `Duration` do CloudWatch não inclui `Init Duration`) |
| `DurableExecutionDuration` | 27.512 ms | o relógio da execução inteira, do início ao fim — 27,5 s contra os 28 s que eu tinha contado à mão pelos timestamps da timeline |

Três fontes — logs, duas métricas de billing — concordando entre si é o que dá
confiança nos números que seguem, não só nesta seção.

### DynamoDB: 33 WRU por boleto, não 24

Esta foi a correção mais cara do relatório. Meu primeiro cálculo contava
escritas de código — `criarBoleto` + 11×`avancar()` (que faz `UpdateItem` no
boleto e `PutItem` no evento) + `atualizarBoleto(executionArn)` — e assumia
**1 WRU por escrita**, dando 24 WRU.

A métrica `ConsumedWriteCapacityUnits`, na mesma janela isolada, devolveu
**33**. A causa: o item `META` do boleto tem cerca de 1,4 KB, e o DynamoDB
cobra em unidades de 1 KB, **arredondando para cima**. Toda escrita nesse item
custa 2 WRU, não 1 — só as escritas nos itens pequenos de evento (`EVT#nnn`)
custam 1. Eu tratei todas as escritas como do mesmo tamanho; não são.

```
13 escritas no item META (create + 11 avancar + executionArn) × 2 WRU = 26
11 escritas nos itens EVT (um por evento da timeline)          × 1 WRU = 11
                                                                          ───
                                                                           37
```

A conta na régua dá 37, a métrica real deu 33 — perto o bastante para
confirmar o mecanismo (arredondamento por item, não por escrita) sem eu
precisar acertar o tamanho exato de cada payload. Usei o **valor medido**
daqui para frente.

Isso é uma lição que vale além dos números deste lab: **para itens acima de 1 KB,
dobrar o campo `data` de um evento pode dobrar o custo de escrita**, mesmo que
o volume de escritas não mude.

---

## 4. Cálculo: 10.000 boletos/mês

Premissas: tempo médio até o pagamento de **2 dias** (nosso timeout é 72 h) e
retenção de **7 dias** (`retention_period` da nossa config).

### Volumes

Iguais nos dois cenários — o free tier muda o que é faturável, não o que é usado.

```
Compute total     10.000 × 8,851 s × 0,5 GB    =  44.255 GB-s
Requests          10.000 × 5 invocações        =  50.000
Operações         10.000 × 18                  = 180.000
Dados gravados    10.000 × 896 B               =   0,00896 GB
Retenção          0,00896 × (2/30 + 7/30)      =   0,00269 GB-mês
```

### Custo

| Linha | Preço unitário | Com free tier | Sem free tier |
|---|---|---|---|
| Compute | USD 0,0000133334 / GB-s | **USD 0,0000** <br><sub>44.255 < 400.000 GB-s</sub> | USD 0,5901 |
| Requests | USD 0,20 / milhão | **USD 0,0000** <br><sub>50.000 < 1.000.000</sub> | USD 0,0100 |
| Operações duráveis | USD 8,00 / milhão | USD 1,4400 | USD 1,4400 |
| Dados gravados | USD 0,25 / GB | USD 0,0022 | USD 0,0022 |
| Retenção | USD 0,15 / GB-mês | USD 0,0004 | USD 0,0004 |
| **TOTAL** | | **USD 1,44** | **USD 2,04** |

O free tier absorve **USD 0,60** — todo o compute e todos os requests. As três
linhas específicas de durable functions (operações, dados, retenção) **não têm
free tier** e são idênticas nas duas colunas.

---

## 5. O stack completo

Durable functions é menos da metade da conta. O resto:

| Serviço | Volume em 10.000 boletos | Com free tier | Sem free tier | Fonte |
|---|---|---|---|---|
| Durable functions — operações | 180.000 operações | USD 1,4400 | USD 1,4400 | medido |
| Durable functions — dados + retenção | 8,96 MB | USD 0,0026 | USD 0,0026 | medido |
| Lambda compute | 44.255 GB-s | USD 0,0000 | USD 0,5901 | medido |
| Lambda requests | 50.000 | USD 0,0000 | USD 0,0100 | medido |
| AppSync — mutations | 240.000 | USD 0,9600 | USD 0,9600 | medido |
| AppSync — updates em tempo real | 240.000 | USD 0,4800 | USD 0,4800 | modelo |
| AppSync — connection-minutes | 10.560 | USD 0,0008 | USD 0,0008 | modelo |
| DynamoDB — escritas | **330.000 WRU** | **USD 0,2063** | **USD 0,2063** | **medido** |
| DynamoDB — leituras | 50.000 RRU | USD 0,0063 | USD 0,0063 | modelo |
| API Gateway HTTP | 30.000 requests | USD 0,0300 | USD 0,0300 | modelo |
| CloudWatch Logs — ingestão | ~120 MB | USD 0,0600 | USD 0,0600 | modelo |
| **TOTAL** | | **USD 3,19** | **USD 3,79** | |

A coluna **fonte** distingue o que veio de métrica do CloudWatch (`medido`) do
que ainda é derivado do código ou de uma suposição de uso (`modelo`). Os
updates em tempo real, as connection-minutes e as leituras do DynamoDB não deu
para isolar de forma limpa: o navegador estava fechado durante a janela de
medição (então `ConnectSuccess`/`SubscribeSuccess` vieram nulos), e as
leituras da janela estavam misturadas com chamadas de `curl` que eu mesmo fiz
para acompanhar o teste. Ficam como estavam — modelo, não medição.

> **Um terceiro cenário:** o AppSync tem free tier próprio de 250.000 operações
> e 250.000 updates em tempo real, mas só nos **primeiros 12 meses** da conta.
> Nossos 240.000 cabem. Numa conta nova o total cairia para **USD 1,75** — e
> subiria de volta no aniversário de 12 meses, o que é exatamente o tipo de
> surpresa que vale anotar antes de prometer um número para alguém.

**As mutations do AppSync foram confirmadas por métrica**, não só derivadas do
código: `PublishDataMessageSuccess`, isolada na mesma janela da execução única,
devolveu exatamente **24** — o mesmo número que sai de contar no código
`11 eventos × 2 mutations + criarBoleto + atualizarBoleto(executionArn)`. Duas
fontes, mesmo resultado, igual ao que aconteceu com as operações duráveis.

**As escritas do DynamoDB, ao contrário, corrigiram o modelo.** Ver a seção 3,
"DynamoDB: 33 WRU por boleto, não 24" — a medição achou 38% a mais do que a
contagem de escritas por código previa, porque o tamanho do item, não só a
quantidade de escritas, entra na conta.

**AppSync praticamente empata com as operações duráveis** — USD 1,4408 contra
USD 1,4400, coincidência que vale reparar. Cada transição publica duas mutations
e cada uma vira um update em tempo real **por assinante conectado**. Com dois
navegadores abertos, a linha de real-time dobra; com dez, ela passa a dominar a
conta inteira.

---

## 6. O que domina o custo, e por quê

A comparação com o exemplo oficial da AWS é o achado mais útil deste relatório:

| | Sinistros (AWS) | Boletos (nosso) |
|---|---|---|
| Compute por execução | 32 s @ 1 GB | 8,85 s @ 0,5 GB |
| Dados gravados | 104 KB | 0,90 KB |
| Operações | 4 | 18 |
| **Compute** | **86% do custo** | 0% *(free tier)* / 29% sem ele |
| **Operações** | 6,5% | **99%** / 71% sem free tier |

São perfis invertidos. A razão:

**Nosso fluxo tem muitas operações e pouco trabalho.** 18 operações para 8,85 s
de compute. O deles: 4 operações para 32 s. Cada operação custa USD 0,000008 —
o equivalente a **1,2 segundo** de compute a 512 MB em arm64. Ou seja: um step
que roda em 200 ms custa seis vezes mais pela operação do que pelo tempo.

Dá para calcular o ponto de equilíbrio: a 512 MB arm64, as 18 operações
(USD 0,000144) empatam com o compute quando a execução gasta

```
0,000144 ÷ (0,5 GB × 0,0000133334) ≈ 21,6 segundos
```

Abaixo disso, operações dominam. Acima, compute domina. Gastamos 8,85 s, então
estamos claramente do lado das operações.

**A lição de arquitetura:** durable functions cobram por *estrutura do
workflow*, não só por trabalho. Quebrar o fluxo em muitos steps pequenos é ótimo
para observabilidade e granularidade de retry, mas cada step tem um preço fixo.
Em fluxos de trabalho curto, conte operações antes de contar milissegundos.

---

## 7. Escala

| Boletos/mês | Com free tier | Sem free tier | Diferença |
|---|---|---|---|
| 1.000 | USD 0,14 | USD 0,20 | o free tier cobre tudo de compute |
| 10.000 | USD 1,44 | USD 2,04 | idem |
| 100.000 | USD 15,00 | USD 20,43 | idem |
| 1.000.000 | USD 198,79 | USD 204,33 | o free tier já quase não importa |

Repare no que a coluna "sem free tier" revela: ela é **estritamente linear** —
USD 0,204 por mil boletos em qualquer volume. É a coluna "com free tier" que
distorce, fazendo parecer que o custo unitário sobe com a escala. Ele não sobe;
o subsídio é que deixa de diluir.

Por isso, para dimensionar qualquer coisa, use a coluna da direita.

Para referência: o exemplo da AWS, com 1 milhão de sinistros, dá USD 490,46 —
USD 0,00049 por sinistro. Nosso boleto sai por USD 0,00020 no mesmo volume,
porque cada execução gasta muito menos compute.

---

## 8. Otimizações possíveis

| Mudança | Operações | Invocações | Com free tier | Sem free tier |
|---|---|---|---|---|
| Como está (`ritmo=6`, parallel `NESTED`) | 18 | 5 | USD 1,44 | USD 2,04 |
| `ritmo_demo_segundos = 0` | 15 | 2 | USD 1,20 | USD 1,80 |
| `ritmo=0` + `NestingType.FLAT` no parallel | 13 | 2 | **USD 1,04 (−28%)** | **USD 1,64 (−20%)** |

<sub>O compute foi mantido constante nas três linhas. Na prática ele cai um
pouco com menos invocações, porque cada retomada reexecuta o handler do topo
para refazer o replay — mas é ruído de dezenas de milissegundos, não medi.</sub>

**As três pausas de ritmo são overhead puro de demonstração.** Elas não custam
compute (a execução fica suspensa), mas cada uma é uma operação cobrada e uma
invocação a mais. Em produção, `ritmo_demo_segundos = 0`.

**`NestingType.FLAT` no `ctx.parallel`** elimina os contextos por ramo. Custa
observabilidade: os ramos deixam de aparecer como operações separadas no
histórico. Vale quando o lote é grande; com dois ramos, é mais uma curiosidade
do que uma economia.

Outras alavancas, em ordem de efeito:

1. **Juntar steps triviais.** `iniciar-pos-baixa` e `encerrar` só escrevem um
   evento na timeline. Poderiam ser absorvidos pelos steps vizinhos, tirando
   2 operações (−11%).
2. **Reduzir as publicações no AppSync.** Publicar o boleto *e* o evento a cada
   transição dobra a linha de real-time. Um único payload combinado cortaria
   AppSync pela metade — cerca de USD 0,72/mês em 10 mil.
3. **Retenção.** Já está em 7 dias contra os 14 do padrão. Irrelevante no nosso
   volume (USD 0,0005), mas relevante se os payloads crescerem.
4. **Memória.** 512 MB é folgado para o que os steps fazem. Só importa quando o
   compute voltar a dominar, acima de ~22 s por execução.

---

## 9. Ressalvas

- **Os preços mudam.** Confira em [aws.amazon.com/lambda/pricing][ex],
  [appsync/pricing](https://aws.amazon.com/appsync/pricing/) e
  [dynamodb/pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/).
- **O free tier é por conta, não por workload.** Os 400.000 GB-s e 1 milhão de
  requests são compartilhados com tudo que roda na conta — daí as duas colunas
  em todas as tabelas. Se a conta já roda outras coisas, use a coluna da
  direita. O do AppSync ainda expira aos 12 meses.
- **O cenário é o caminho feliz.** Toda retentativa reexecuta o step e gera
  operação e compute novos. Um modo de caos com 2 falhas na baixa adiciona
  2 operações e ~4 s de compute por boleto afetado.
- **Boletos não pagos.** Uma execução que expira no timeout de 72 h gasta menos
  operações (para antes da baixa) mas fica 3 dias ocupando retenção em execução.
- **Os dados gravados vêm da métrica oficial**, não de estimativa. A primeira
  versão deste relatório somava os payloads do histórico e errava 21% para
  cima; a métrica `DurableExecutionStorageWrittenBytes` é a fonte correta.
- **As escritas do DynamoDB também vieram de métrica**, e corrigiram o modelo
  em 38%: o custo depende do tamanho do item, não só da contagem de escritas.
  Ver a seção 3.
- **Nem tudo pôde ser medido de forma limpa.** Updates em tempo real do
  AppSync, connection-minutes e leituras do DynamoDB continuam vindo do código
  ou de uma suposição de uso (marcado como "modelo" na tabela da seção 5) —
  medir essas linhas exigiria isolar tráfego de navegador real, o que a janela
  usada aqui não tinha.
- **Não inclui:** transferência de dados, CloudWatch Logs além da ingestão,
  CloudTrail data events (se você ligar auditoria de checkpoint) e o custo de
  hospedar o frontend, que neste lab roda local.

---

## Como reproduzir estes números

A leitura mais confiável é isolar **uma única execução numa janela sem outro
tráfego** — sem outros boletos rodando, sem chamadas manuais de teste — e ler
as métricas oficiais direto do CloudWatch. Foi assim que a correção do
DynamoDB apareceu.

```bash
cd app/infra
export AWS_PROFILE=meu-perfil
FN=$(tofu output -raw nome_funcao_orquestrador)
TABELA=$(tofu output -raw tabela_boletos)
APPSYNC_ID=$(aws appsync list-graphql-apis --region us-east-2 \
  --query "graphqlApis[?name=='${FN%-orquestrador}-api'].apiId" --output text)

INICIO=2026-09-15T00:00:00Z
FIM=2026-09-15T01:00:00Z   # ajuste para uma janela sua, de preferência estreita

# Atenção ao shell: em zsh, uma variável não citada não sofre word-splitting
# como em bash — cite as flags ou monte-as num array. Foi isso que zerou os
# meus primeiros resultados aqui.

# Operações e bytes gravados — a fonte autoritativa para durable functions.
# ExecutedVersion isola uma versão específica.
for M in DurableExecutionOperations DurableExecutionStorageWrittenBytes \
         DurableExecutionDuration DurableExecutionStarted DurableExecutionSucceeded; do
  aws cloudwatch get-metric-statistics --region us-east-2 \
    --namespace AWS/Lambda --metric-name "$M" \
    --dimensions Name=FunctionName,Value="$FN" \
    --start-time "$INICIO" --end-time "$FIM" \
    --period 3600 --statistics Sum --query 'Datapoints[].Sum' --output text
done

# Compute faturado por invocação, direto dos REPORT lines
aws logs filter-log-events --region us-east-2 --log-group-name "/aws/lambda/$FN" \
  --filter-pattern '{ $.type = "platform.report" }'

# Escritas reais no DynamoDB — é aqui que o arredondamento por item aparece
aws cloudwatch get-metric-statistics --region us-east-2 \
  --namespace AWS/DynamoDB --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value="$TABELA" \
  --start-time "$INICIO" --end-time "$FIM" \
  --period 3600 --statistics Sum --query 'Datapoints[].Sum' --output text

# Mutations reais no AppSync
aws cloudwatch get-metric-statistics --region us-east-2 \
  --namespace AWS/AppSync --metric-name PublishDataMessageSuccess \
  --dimensions Name=GraphQLAPIId,Value="$APPSYNC_ID" \
  --start-time "$INICIO" --end-time "$FIM" \
  --period 3600 --statistics Sum --query 'Datapoints[].Sum' --output text

# Histórico evento a evento de uma execução (o AWS CLI v2 ainda não tem o
# comando; este script usa o SDK JS já empacotado no backend)
cd ../backend && node scripts/historico.mjs "<url do console>" historico.json
```
