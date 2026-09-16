# Mesa de aprovações — segundo laboratório de durable functions

Um fluxo de **aprovação de compras** conduzido por uma AWS Lambda durable
function: uma solicitação é roteada por valor, passa por decisão humana
(com escalonamento se ninguém responder) e termina executando o pagamento.

Este é o **segundo** laboratório do repositório. O primeiro
([`app/`](../app/), fluxo de boleto) é sempre linear: emissão, um único
callback, baixa, extrato em paralelo, conciliação. Este aqui foi desenhado
para cobrir o que aquele não cobre. Se você ainda não leu
**[`app/README.md`](../app/README.md)**, comece por lá — ele explica o básico
(suspensão, replay, determinismo) que este documento não repete.

```
  POST /solicitacoes                              clique em Aprovar/Rejeitar
       │                                              (nesta própria UI)
       ▼                                                     │
  ┌─────────┐   Invoke (Event)   ┌──────────────────────────────────────────┐
  │   API   │ ─────────────────► │           orquestrador (durable)         │
  │ Lambda  │                    │                                          │
  └─────────┘ ◄───────────────── │  step  registrar-solicitação             │
       │      SendDurableExecu-  │  decidirRota(valor)  — puro, sem I/O     │
       │      tionCallbackSuccess│                                          │
       │      /Failure           │  se automático:  step aprovar            │
       │                         │  se só gestor:   ⏸ waitForCallback       │
       │                         │                     └─ timeout? escala   │
       │                         │                        ⏸ waitForCallback │
       │                         │  se alto valor:  ∥ parallel              │
       │                         │      ├─ waitForCallback (gestor+esc.)    │
       │                         │      └─ waitForCallback (financeiro)     │
       │                         │  step  executar-pagamento (AtMostOnce)   │
       │                         │  step  notificar-solicitante             │
       │                         └──────────────────────────────────────────┘
       │                                          │
       ▼                                          ▼
   DynamoDB  ◄──── leitura ────  AppSync  ◄── publish (IAM) ──┘
  (verdade)                     (tempo real)
                                     │ subscription (API key)
                                     ▼
                                React + Vite (porta 5174)
```

---

## O que este laboratório ensina, que o de boleto não ensina

**1. Roteamento condicional por valor.**
`decidirRota(valorCentavos, ...)` é uma função pura — sem I/O, sem chamada a
serviço nenhum. É seguro chamá-la **fora** de um step porque o valor de
entrada já veio de um checkpoint anterior (o payload da invocação): em
qualquer replay, o mesmo valor produz a mesma rota. O boleto nunca ramifica;
este fluxo ramifica em três caminhos possíveis a partir de uma única
condição.

**2. Escalonamento — dois `waitForCallback` em cadeia.**
Se o gestor não decide no prazo (`prazo_gestor_minutos`, padrão 24h), o SDK
lança `CallbackTimeoutError`. O código captura, registra o escalonamento e
abre um **segundo** callback — agora para a diretoria, com prazo próprio. Só
depois dos dois prazos vencidos a solicitação expira. Ver `pedirDecisao` e
`fluxoAprovacaoComEscalonamento` em
[`backend/src/orchestrator.mjs`](backend/src/orchestrator.mjs).

**3. `ctx.parallel` com `waitForCallback` dentro de cada ramo.**
Para valores altos (`limite_financeiro_centavos`, padrão R$ 5.000), gestor e
financeiro decidem **ao mesmo tempo**, cada um no seu próprio callback e no
seu próprio contexto filho. O boleto só usou `parallel` com `step`s comuns.

Um detalhe de UI que decorre direto disso: com dois callbacks abertos ao
mesmo tempo, o campo `status` da solicitação só reflete a escrita mais
recente de **qualquer um** dos dois ramos — não dá para usá-lo para saber "o
que eu ainda posso decidir". O frontend checa os campos por papel
(`callbackIdGestor`/`decisaoGestor`, etc.) diretamente. Ver o comentário em
[`frontend/src/components/PainelDecisao.jsx`](frontend/src/components/PainelDecisao.jsx).

**4. As duas metades da API de callback, cada uma pelo motivo certo.**
Rejeitar uma solicitação **não é uma falha** — é um resultado de negócio
válido, e por isso é resolvido com `SendDurableExecutionCallbackSuccess`
carregando `{decisao: "rejeitado"}`, exatamente como uma aprovação. O
`SendDurableExecutionCallbackFailure` fica reservado para quando o
financeiro relata que **não consegue processar agora** — uma falha técnica
de verdade, capturada como `CallbackExternalError` e tratada de forma
diferente de um simples "não".

**5. A mesma lição central do app de boleto, reaplicada.**
O step que executa o pagamento usa `AtMostOncePerRetry`, e só fica seguro de
verdade porque a política de retry recusa `StepInterruptedError` — a mesma
armadilha (e a mesma correção) do laboratório de boleto, agora em um
contexto novo, para provar que a lição é do recurso, não do domínio.

---

## Rodando

Os passos são os mesmos do primeiro laboratório, em uma pasta paralela:

```bash
cd app-approval

# 1. empacota o backend
make build

# 2. cria tudo na AWS. Ao final grava frontend/.env.local
make deploy

# 3. sobe a interface — porta 5174, para rodar ao lado de app/ (porta 5173)
make dev
```

Sem `make`:

```bash
cd backend  && npm install && npm run build
cd ../infra && tofu init && tofu apply -var perfil_aws=meu-perfil
cd ../frontend && npm install && npm run dev
```

> Assim como em `app/`, crie `infra/terraform.tfvars` (ignorado pelo git) com
> `perfil_aws = "seu-perfil"` para não precisar passar `-var` toda vez. Há um
> modelo em [`infra/terraform.tfvars.example`](infra/terraform.tfvars.example).

Este é um stack **AWS separado** do primeiro laboratório — prefixo
`lab-aprovacao-*`, tabela e função próprias. Os dois podem ficar no ar ao
mesmo tempo sem colidir.

---

## O roteiro do laboratório

### 1. Aprovação automática

Solicite um valor abaixo de R$ 300. A solicitação vai direto para
`APROVADA` e depois `PAGA`, sem nenhum callback aberto — o roteamento
decidiu isso sem nunca suspender a execução.

### 2. Aprovação simples

Solicite entre R$ 300 e R$ 5.000. A solicitação para em **aguardando
gestor**. Abra a aba *Durable executions* da função no console
(`tofu output -raw console_execucoes_durable`, dentro de `infra/`): a
execução está `RUNNING` sem nenhuma invocação acontecendo.

Clique em **Aprovar** (ou **Rejeitar**) na própria tela. Isso chama
`POST /solicitacoes/{id}/decidir`, que resolve o `callbackIdGestor` com
`SendDurableExecutionCallbackSuccess`. A diferença para o app de boleto: ali
o "pagamento" simulava um webhook externo; aqui o clique **é** o evento que
a execução está esperando, sem simulação nenhuma no meio.

### 3. Escalonamento

Solicite um valor que exija gestor e **não decida**. Espere o
`prazo_gestor_minutos` vencer (baixe para 1-2 minutos em
`infra/terraform.tfvars` para ver isso em uma demo ao vivo, em vez de
esperar 24h). A timeline registra o escalonamento e a solicitação passa a
aguardar a diretoria, com um `callbackIdDiretoria` novo. Decida por ela, ou
deixe vencer de novo para ver a solicitação expirar.

### 4. Aprovação dupla, em paralelo

Solicite acima de R$ 5.000. Dois painéis de decisão aparecem ao mesmo
tempo — gestor e financeiro. Decida um e observe que o outro continua
esperando normalmente: são dois `waitForCallback` independentes, cada um no
seu ramo do `ctx.parallel`. Rejeite qualquer um dos dois e veja a
solicitação terminar como `REJEITADA` mesmo que o outro ramo ainda não
tenha decidido.

### 5. Indisponibilidade técnica do financeiro

Numa solicitação de alto valor com o financeiro pendente, clique em
**Reportar indisponibilidade** em vez de aprovar ou rejeitar. Isso chama
`SendDurableExecutionCallbackFailure`, e o `CallbackExternalError`
resultante é tratado como um caso distinto de "rejeitado" — mensagem
própria na timeline, nível `ERROR`.

### 6. O laboratório de caos

Os três modos giram em torno do step de execução do pagamento, a etapa com
efeito colateral irreversível — os mesmos dois experimentos do app de
boleto, aqui aplicados ao pagamento em vez da baixa:

- **Falhar o pagamento**: retry com backoff exponencial.
- **Derrubar antes de pagar**: a conferência constata que nada foi aplicado
  e refaz com segurança.
- **Derrubar depois de pagar, antes do checkpoint**: o caso caro — o
  dinheiro já saiu, o durable não sabe, e a conferência acha o comprovante
  em vez de repetir o pagamento.

O experimento de comentar a linha que recusa `StepInterruptedError` em
`RETRY_PAGAMENTO` (ver [`app/README.md`](../app/README.md#3-a-lição-principal--interrupção-no-meio-do-efeito-colateral))
funciona exatamente igual aqui.

---

## Mapa dos arquivos

```
backend/
  src/orchestrator.mjs      ← a durable function. As diferenças para o app de
                               boleto estão nos comentários do cabeçalho.
  src/api.mjs                ← start, decidir (aprovar/rejeitar/falha-técnica), stop, get
  src/shared/domain.mjs      ← decidirRota, papéis, status
  src/shared/store.mjs       ← DynamoDB + avancar() — igual ao app de boleto
  src/shared/chaos.mjs       ← 3 modos, em volta do pagamento
  src/shared/appsync.mjs     ← publica no AppSync — igual ao app de boleto

infra/
  lambda.tf                  ← variáveis novas: limites de valor, prazos por papel
  schema.graphql             ← tipo Solicitacao com os campos por papel

frontend/
  src/components/PainelDecisao.jsx  ← o componente novo: aprovar/rejeitar/reportar
  src/components/Pipeline.jsx       ← 3 etapas em vez de 5
```

O resto (`store.mjs`, `chaos.mjs` na mecânica, `appsync.mjs`, `Timeline.jsx`,
a estrutura da infra) é o mesmo padrão do primeiro laboratório, só com os
nomes trocados de boleto para solicitação. Reaproveitar a estrutura de
propósito: o objetivo é mostrar que durable functions é um jeito de
escrever código, não uma arquitetura que se aprende uma vez por projeto.

---

## Custos

Medido direto na AWS a partir de execuções reais deste laboratório — os seis
cenários (automática, gestor simples, paralelo, falha técnica, caos) com
operações, bytes e compute exatos, mais uma projeção para 10.000
solicitações/mês. Ver
[`docs/reports/custo-aprovacao.md`](../docs/reports/custo-aprovacao.md).

---

## Segurança

As mesmas regras do primeiro laboratório — token compartilhado nas rotas da
API, `terraform.tfstate`/`.env.local`/`terraform.tfvars` fora do commit,
nenhum ARN ou ID de conta hardcoded. Ver
[`app/README.md`](../app/README.md#segurança) para o detalhe completo.

Uma coisa específica deste app: qualquer pessoa com o token pode aprovar ou
rejeitar qualquer solicitação, de qualquer valor — não há autenticação de
quem é o "gestor" de verdade. É adequado para um laboratório de uma pessoa;
um sistema real precisaria de identidade por aprovador (Cognito, SSO) antes
de decidir qualquer coisa com dinheiro de verdade.

---

## Derrubando

```bash
make destroy
```

Independente do `app/` — derrubar um não afeta o outro.
