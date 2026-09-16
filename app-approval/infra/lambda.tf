resource "aws_cloudwatch_log_group" "orquestrador" {
  name              = "/aws/lambda/${local.nome_orq}"
  retention_in_days = var.retencao_logs_dias
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.nome_api}"
  retention_in_days = var.retencao_logs_dias
}

# ── A durable function ────────────────────────────────────────────────────────
#
# `durable_config` so pode ser definido na CRIACAO da funcao; `publish = true`
# e o alias sao o que garante ARN qualificado nas invocacoes. Ver
# app/infra/lambda.tf para a explicacao completa desses tres pontos.
resource "aws_lambda_function" "orquestrador" {
  function_name = local.nome_orq
  role          = aws_iam_role.orquestrador.arn
  runtime       = var.runtime_lambda
  handler       = "orchestrator.handler"
  architectures = [var.arquitetura]

  filename         = var.caminho_zip_backend
  source_code_hash = local.hash_zip

  timeout     = 120
  memory_size = 512
  publish     = true

  durable_config {
    execution_timeout = var.timeout_execucao_segundos
    retention_period  = var.retencao_historico_dias
  }

  environment {
    variables = {
      TABELA_SOLICITACOES        = aws_dynamodb_table.solicitacoes.name
      APPSYNC_ENDPOINT           = aws_appsync_graphql_api.principal.uris["GRAPHQL"]
      LIMITE_AUTOMATICO_CENTAVOS = tostring(var.limite_automatico_centavos)
      LIMITE_FINANCEIRO_CENTAVOS = tostring(var.limite_financeiro_centavos)
      PRAZO_GESTOR_MINUTOS       = tostring(var.prazo_gestor_minutos)
      PRAZO_DIRETORIA_MINUTOS    = tostring(var.prazo_diretoria_minutos)
      PRAZO_FINANCEIRO_MINUTOS   = tostring(var.prazo_financeiro_minutos)
      RITMO_DEMO_SEGUNDOS        = tostring(var.ritmo_demo_segundos)
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.orquestrador.name
  }

  depends_on = [
    aws_iam_role_policy_attachment.orquestrador_durable,
    aws_iam_role_policy.orquestrador_dados,
  ]
}

resource "aws_lambda_alias" "orquestrador" {
  name             = "prod"
  function_name    = aws_lambda_function.orquestrador.function_name
  function_version = aws_lambda_function.orquestrador.version
  description      = "Alias usado pela API para iniciar execucoes durable"
}

# ── A API HTTP (Lambda comum) ─────────────────────────────────────────────────

resource "aws_lambda_function" "api" {
  function_name = local.nome_api
  role          = aws_iam_role.api.arn
  runtime       = var.runtime_lambda
  handler       = "api.handler"
  architectures = [var.arquitetura]

  filename         = var.caminho_zip_backend
  source_code_hash = local.hash_zip

  timeout     = 30
  memory_size = 512

  environment {
    variables = {
      TABELA_SOLICITACOES = aws_dynamodb_table.solicitacoes.name
      APPSYNC_ENDPOINT    = aws_appsync_graphql_api.principal.uris["GRAPHQL"]
      ORQUESTRADOR_ARN    = aws_lambda_alias.orquestrador.arn
      TOKEN_API           = random_password.token_api.result
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.api.name
  }

  depends_on = [
    aws_iam_role_policy_attachment.api_basica,
    aws_iam_role_policy.api,
  ]
}
