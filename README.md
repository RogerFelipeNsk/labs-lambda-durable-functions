# Laboratório de AWS Lambda durable functions

Uma aplicação completa e funcional para entender **Lambda durable functions** na
prática: um fluxo de cobrança em que a emissão do boleto, a espera pelo
pagamento, a baixa, o extrato e a conciliação acontecem numa **única execução
durável** — que fica suspensa por dias, sem consumir compute, até o webhook do
banco chegar.

Backend em Node.js, infraestrutura em OpenTofu, frontend em React com
atualização em tempo real por AppSync. Tudo sobe com dois comandos.

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

> **Quer entender o *porquê* de cada decisão?** Este arquivo é o guia
> operacional. A explicação técnica — semânticas de step, replay, determinismo,
> as pegadinhas do recurso — está em **[`app/README.md`](app/README.md)**.

---

## O que este repositório contém

| Pasta | O que é |
|---|---|
| [`app/`](app/) | A aplicação: `backend/`, `frontend/` e `infra/` |
| [`docs/reports/`](docs/reports/) | [Relatório de custos](docs/reports/custo-durable-functions.md) — quanto custa rodar 10 mil boletos/mês, medido na execução real |

`floci/`, se existir na sua cópia, é um clone de estudo do
[Floci](https://github.com/floci-io/floci) e está no `.gitignore`, assim como o
material de trabalho em `docs/` que não é o relatório.

---

## Pré-requisitos

| | Versão | Como conferir |
|---|---|---|
| **OpenTofu** | ≥ 1.9 | `tofu version` |
| **Node.js** | ≥ 22 | `node -v` |
| **AWS CLI** | v2 | `aws --version` |
| **Conta AWS** | com Lambda durable functions disponível | veja abaixo |

Duas restrições que valem conhecer antes de começar:

- O **provider AWS precisa ser ≥ 6.25.0** — antes dessa versão o argumento
  `durable_config` simplesmente não existe. O `versions.tf` já exige isso; o
  `tofu init` resolve sozinho.
- A **região precisa ter durable functions**. `us-east-2` e `us-east-1`
  funcionam. O padrão do lab é `us-east-2`.

Custo: tudo é sob demanda e nada fica provisionado. Um dia de laboratório fica
na casa de centavos. Ainda assim, veja [Derrubando tudo](#derrubando-tudo) ao
terminar.

---

## 1. Configurar o acesso à AWS

Você precisa de credenciais com permissão para criar Lambda, DynamoDB, AppSync,
API Gateway e IAM roles.

### Se você usa perfis nomeados no `~/.aws/config`

Crie `app/infra/terraform.tfvars` — ele é **ignorado pelo git** e é onde mora a
sua configuração pessoal:

```hcl
perfil_aws = "meu-perfil"
regiao     = "us-east-2"
```

O OpenTofu carrega esse arquivo automaticamente. Pronto, nada mais a fazer.

Há um modelo em [`app/infra/terraform.tfvars.example`](app/infra/terraform.tfvars.example).

### Se você usa variáveis de ambiente, SSO ou instance profile

Não configure nada: o padrão de `perfil_aws` é vazio, e o provider cai na cadeia
normal de credenciais da AWS.

### Conferindo antes de gastar tempo

```bash
aws sts get-caller-identity --profile meu-perfil
```

Se isso não devolver sua conta, o `tofu apply` vai falhar com
`No valid credential sources found`.

---

## 2. Subir na AWS

```bash
cd app
make deploy
```

São dois passos por trás: `npm run build` no backend (empacota `src/` +
`node_modules` em `dist/backend.zip`) e `tofu init && tofu apply` na infra.

Se preferir sem `make`:

```bash
cd app/backend && npm install && npm run build
cd ../infra    && tofu init && tofu apply
```

> **A ordem importa.** O OpenTofu lê o ZIP do backend para calcular o hash do
> código, então o build precisa acontecer **antes** do plan. Se pular, o erro é
> `Error in function call` apontando para `locals.tf`.

Para escolher o perfil sem criar o `terraform.tfvars`:

```bash
make deploy PERFIL=meu-perfil
```

Ao final o apply grava **`app/frontend/.env.local`** com todos os endpoints e
segredos que o frontend precisa. Você não copia nada na mão.

### Ajustando o ritmo da demonstração

Por padrão o workflow faz uma pausa de **6 segundos entre as etapas**, para dar
tempo de acompanhar a timeline na tela. Para mudar, em `app/infra/terraform.tfvars`:

```hcl
ritmo_demo_segundos = 15   # mais devagar, melhor para apresentar
# ritmo_demo_segundos = 0  # sem pausa, fluxo na velocidade máxima
```

Essas pausas usam `ctx.wait`, que **suspende a execução de verdade** — a
invocação termina e a Lambda só é chamada de novo quando o prazo vence. Subir
esse número não aumenta o custo de compute, só adia a retomada.

### O que foi criado

Cerca de 40 recursos na AWS, mais o `.env.local` local. Os que importam:

| Recurso | Papel |
|---|---|
| `lab-conciliacao-orquestrador` | a durable function, com `durable_config` e versão publicada |
| `lab-conciliacao-orquestrador:prod` | alias — durable functions exigem ARN qualificado |
| `lab-conciliacao-api` | Lambda comum, fronteira HTTP |
| API Gateway HTTP | 8 rotas, CORS liberado para o Vite local |
| DynamoDB `lab-conciliacao-boletos` | tabela única: boleto + linha do tempo |
| AppSync GraphQL | tempo real (API key para ler, IAM para publicar) |

---

## 3. Rodar o frontend

```bash
cd app/frontend
npm install
npm run dev
```

Abra **http://localhost:5173**. O indicador no canto superior direito deve
mostrar *tempo real ligado* — é a subscription do AppSync conectada.

Se aparecer erro de variável de ambiente faltando, é porque o `.env.local` não
foi gerado: rode o `tofu apply` antes.

---

## 4. Testar

### Pela interface

1. **Emitir cobrança** — preencha e clique em *Emitir e iniciar execução*.
   O boleto para em **aguardando pagamento**.
2. Neste momento, abra a aba **Durable executions** da função no console AWS:

   ```bash
   cd app/infra && tofu output -raw console_execucoes_durable
   ```

   A execução está `RUNNING`, mas nenhuma invocação está acontecendo. É a
   suspensão real — o ponto central do recurso.
3. **Registrar pagamento** — é o webhook do banco resolvendo o callback. Daqui
   até a conciliação a timeline se completa sozinha, por subscription. A tela
   nunca faz polling.

### Pelo terminal

Todas as rotas exigem o header `x-lab-token`, exceto `GET /saude`:

```bash
cd app/infra
API=$(tofu output -raw api_url | sed 's:/$::')
TOKEN=$(tofu output -raw token_api)
H="x-lab-token: $TOKEN"

# emitir
ID=$(curl -s -X POST "$API/boletos" -H "$H" -H 'content-type: application/json' \
  -d '{"sacado":"Padaria do Jonas ME","valorCentavos":125000}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).boleto.id')

# esperar o workflow registrar o callback (leva ~1s)
until curl -s -H "$H" "$API/boletos/$ID" | grep -q callbackId; do sleep 1; done

# pagar
curl -s -X POST "$API/boletos/$ID/pagar" -H "$H" -H 'content-type: application/json' -d '{}'

# acompanhar
curl -s -H "$H" "$API/boletos/$ID" | node -pe '
  JSON.parse(require("fs").readFileSync(0)).eventos
    .map(e => `${e.at.slice(11,19)} ${e.stage.padEnd(12)} ${e.message}`).join("\n")'

# a visão da AWS, não a da nossa tabela
curl -s -H "$H" "$API/boletos/$ID/execucao"
```

### Rotas disponíveis

| Rota | O que faz |
|---|---|
| `GET /saude` | health check (única rota aberta) |
| `POST /boletos` | emite e **inicia** a execução durable |
| `GET /boletos` | lista |
| `GET /boletos/{id}` | boleto + linha do tempo completa |
| `POST /boletos/{id}/pagar` | simula o webhook e **resolve o callback** |
| `POST /boletos/{id}/caos` | arma uma falha no próximo step |
| `POST /boletos/{id}/parar` | `StopDurableExecution` |
| `GET /boletos/{id}/execucao` | `GetDurableExecution` |

---

## 5. O painel de caos

É aqui que o laboratório ensina. Cada modo existe para tornar visível uma
garantia que só aparece quando algo dá errado. Arme **antes** de pagar.

| Modo | O que prova |
|---|---|
| `falhar-baixa` | retry com backoff exponencial e jitter — as tentativas aparecem numeradas na timeline |
| `derrubar-antes-baixa` | a invocação morre antes do efeito; a conferência constata que nada foi aplicado e refaz com segurança |
| `derrubar-apos-baixa` | **o caso caro**: o dinheiro já se moveu mas o checkpoint não existe. Um retry cego daria baixa em duplicidade |
| `falhar-extrato` | um ramo do `parallel` falha e é retentado sem afetar o outro |
| `divergencia` | o extrato reporta valor diferente e a conciliação fecha com divergência, em nível `WARN` |

Pelo terminal:

```bash
curl -s -X POST "$API/boletos/$ID/caos" -H "$H" -H 'content-type: application/json' \
  -d '{"modo":"derrubar-apos-baixa","vezes":1}'
```

A explicação de *por que* cada um desses casos importa — e o experimento que
mostra `AtMostOncePerRetry` falhando quando a política de retry está errada —
está em [`app/README.md`](app/README.md#o-roteiro-do-laboratório).

---

## Comandos do Makefile

Todos rodam de dentro de `app/`.

| Comando | O que faz |
|---|---|
| `make build` | empacota o backend em `backend/dist/backend.zip` |
| `make plano` | build + `tofu plan` |
| `make deploy` | build + `tofu apply` + gera o `.env.local` |
| `make dev` | sobe o frontend em http://localhost:5173 |
| `make logs` | segue os logs da durable function no CloudWatch |
| `make destroy` | derruba tudo |
| `make limpar` | apaga `node_modules` e artefatos de build |

Aceitam `PERFIL=nome` para escolher o perfil AWS pontualmente.

---

## Alterando o código

**Backend** — qualquer mudança em `app/backend/src/` exige rebuild e apply:

```bash
cd app && make deploy
```

Isso publica uma **nova versão** da durable function e move o alias `prod`.
Execuções que já estavam em andamento continuam na versão em que nasceram — é
essa imutabilidade que garante que o replay rode o mesmo código, mesmo dias
depois de um deploy.

**Frontend** — o Vite recarrega sozinho, sem deploy.

**Infra** — `tofu apply` normal. Uma exceção importante: `durable_config` só
pode ser definido na **criação** da função. Não dá para ligar ou desligar
durable execution numa Lambda existente; é destroy/create.

---

## Problemas comuns

**`Error in function call` apontando para `locals.tf`**
O ZIP do backend não existe. Rode `make build` (ou `cd backend && npm run build`)
antes do plan.

**`No valid credential sources found`**
O OpenTofu não achou credenciais. Crie `app/infra/terraform.tfvars` com
`perfil_aws`, ou exporte as variáveis de ambiente da AWS.

**`durable_config` não é um argumento válido**
Provider AWS abaixo de 6.25.0. Rode `tofu init -upgrade`.

**Frontend abre com erro de variável faltando**
`app/frontend/.env.local` não foi gerado. Rode o `tofu apply`.

**O botão "Registrar pagamento" está desabilitado**
A execução ainda não registrou o callback — leva cerca de um segundo depois da
emissão. Ele habilita sozinho quando o `callbackId` chega pela subscription.

**HTTP 401 nas chamadas por curl**
Faltou o header `x-lab-token`. Pegue com `tofu output -raw token_api`.

**HTTP 409 ao pagar**
O callback ainda não existe (pagou rápido demais) ou o boleto já foi pago.
Espere o campo `callbackId` aparecer em `GET /boletos/{id}`.

**O indicador de tempo real fica em "sem conexão"**
A API key do AppSync expira em 30 dias. `tofu apply` gera uma nova.

---

## Derrubando tudo

```bash
cd app
make destroy
```

Execuções em andamento morrem junto. Se quiser um encerramento limpo, pare-as
antes pelo painel de caos ou por `StopDurableExecution`.

Vale o hábito: a API é um endpoint público protegido apenas por um token
compartilhado, e DynamoDB on-demand com Lambda atrás não tem teto natural de
gasto. Se não estiver usando, derrube.

---

## Segurança

Resumo, com o detalhe em [`app/README.md`](app/README.md#segurança):

- As rotas da API exigem um token compartilhado gerado no `apply` — sem ele, o
  endpoint seria anônimo e capaz de criar execuções durable na sua conta.
- A API key do AppSync vai para o navegador por desenho, e só permite **ler e
  assinar**. Publicar exige IAM e é exclusivo das Lambdas.
- `terraform.tfstate`, `terraform.tfvars` e `.env.local` guardam segredos em
  claro e estão no `.gitignore`. Nenhum ARN, ID de conta ou endpoint real
  aparece no código.
- O `process.exit(1)` do painel de caos derruba o processo de propósito, para
  provar o comportamento de replay. É didático, não copie para produção.

---

## Licença

MIT — veja [LICENSE](LICENSE). Use, copie e adapte à vontade.

---

## Referências

- [Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html)
- [AWS Durable Execution SDK](https://docs.aws.amazon.com/durable-execution/)
- [Segurança e permissões](https://docs.aws.amazon.com/lambda/latest/dg/durable-security.html)
- [Deploy por infraestrutura como código](https://docs.aws.amazon.com/lambda/latest/dg/durable-getting-started-iac.html)
