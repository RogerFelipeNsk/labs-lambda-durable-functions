data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "assume_appsync" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["appsync.amazonaws.com"]
    }
  }
}

# ── Papeis do AppSync ─────────────────────────────────────────────────────────

resource "aws_iam_role" "appsync_logs" {
  name               = "${local.prefixo}-appsync-logs"
  assume_role_policy = data.aws_iam_policy_document.assume_appsync.json
}

resource "aws_iam_role_policy_attachment" "appsync_logs" {
  role       = aws_iam_role.appsync_logs.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppSyncPushToCloudWatchLogs"
}

resource "aws_iam_role" "appsync_dynamo" {
  name               = "${local.prefixo}-appsync-dynamo"
  assume_role_policy = data.aws_iam_policy_document.assume_appsync.json
}

# O AppSync so LE a tabela. Toda escrita passa pelas Lambdas, que e onde as
# regras de negocio e a maquina de estados vivem.
data "aws_iam_policy_document" "appsync_dynamo" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.solicitacoes.arn, "${aws_dynamodb_table.solicitacoes.arn}/index/*"]
  }
}

resource "aws_iam_role_policy" "appsync_dynamo" {
  name   = "leitura-solicitacoes"
  role   = aws_iam_role.appsync_dynamo.id
  policy = data.aws_iam_policy_document.appsync_dynamo.json
}

# ── Politicas compartilhadas pelas Lambdas ────────────────────────────────────

data "aws_iam_policy_document" "tabela_solicitacoes" {
  statement {
    sid = "EscritaELeituraDasSolicitacoes"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]
    resources = [aws_dynamodb_table.solicitacoes.arn, "${aws_dynamodb_table.solicitacoes.arn}/index/*"]
  }
}

# Somente as duas mutations de publicacao. O restante do schema (queries e
# subscriptions) e territorio da API key do navegador.
data "aws_iam_policy_document" "publicar_appsync" {
  statement {
    sid     = "PublicarEventosDeTempoReal"
    actions = ["appsync:GraphQL"]
    resources = [
      "${aws_appsync_graphql_api.principal.arn}/types/Mutation/fields/publishSolicitacao",
      "${aws_appsync_graphql_api.principal.arn}/types/Mutation/fields/publishEvent",
    ]
  }
}

# ── Papel do orquestrador (a durable function) ────────────────────────────────

resource "aws_iam_role" "orquestrador" {
  name               = "${local.nome_orq}-role"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

# Esta policy gerenciada traz o que a funcao precisa para gravar checkpoints
# (lambda:CheckpointDurableExecution e lambda:GetDurableExecutionState) alem
# das permissoes basicas de CloudWatch Logs.
resource "aws_iam_role_policy_attachment" "orquestrador_durable" {
  role       = aws_iam_role.orquestrador.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy"
}

resource "aws_iam_role_policy" "orquestrador_dados" {
  name   = "dados-e-tempo-real"
  role   = aws_iam_role.orquestrador.id
  policy = data.aws_iam_policy_document.orquestrador.json
}

data "aws_iam_policy_document" "orquestrador" {
  source_policy_documents = [
    data.aws_iam_policy_document.tabela_solicitacoes.json,
    data.aws_iam_policy_document.publicar_appsync.json,
  ]
}

# ── Papel da API HTTP ─────────────────────────────────────────────────────────

resource "aws_iam_role" "api" {
  name               = "${local.nome_api}-role"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

resource "aws_iam_role_policy_attachment" "api_basica" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "api_durable" {
  statement {
    sid       = "IniciarExecucao"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_alias.orquestrador.arn, "${local.arn_funcao}:*"]
  }

  # Estas acoes sao autorizadas contra o ARN da EXECUCAO durable, que estende o
  # ARN da versao da funcao. Um ARN sem qualificador nunca casaria, por isso
  # o ":*" — que aqui cobre qualquer versao publicada.
  statement {
    sid = "ControlarExecucoesDurable"
    actions = [
      "lambda:SendDurableExecutionCallbackSuccess",
      "lambda:SendDurableExecutionCallbackFailure",
      "lambda:SendDurableExecutionCallbackHeartbeat",
      "lambda:StopDurableExecution",
      "lambda:GetDurableExecution",
      "lambda:GetDurableExecutionHistory",
    ]
    resources = [local.arn_execucoes_durable]
  }

  statement {
    sid       = "ListarExecucoes"
    actions   = ["lambda:ListDurableExecutionsByFunction"]
    resources = [local.arn_funcao, local.arn_execucoes_durable]
  }
}

data "aws_iam_policy_document" "api" {
  source_policy_documents = [
    data.aws_iam_policy_document.tabela_solicitacoes.json,
    data.aws_iam_policy_document.publicar_appsync.json,
    data.aws_iam_policy_document.api_durable.json,
  ]
}

resource "aws_iam_role_policy" "api" {
  name   = "orquestracao-e-dados"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}
