# Criamos os log groups explicitamente para controlar a retencao. Se deixarmos
# a Lambda criar sozinha, o padrao e "nunca expirar".
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
# Tres detalhes que nao existem numa Lambda comum:
#
#   1. O bloco `durable_config` so pode ser definido na CRIACAO da funcao.
#      Nao da para ligar durable execution em uma funcao que ja existe — se
#      voce esquecer, e destroy/create.
#
#   2. `timeout` aqui e o limite de UMA invocacao. O limite do fluxo inteiro,
#      incluindo os dias parado esperando o pagamento, e o `execution_timeout`.
#
#   3. `publish = true` e obrigatorio na pratica: durable functions so aceitam
#      ARN qualificado na invocacao, e uma execucao fica presa a versao em que
#      comecou — e o que garante que o replay roda o mesmo codigo, mesmo dias
#      depois de um deploy novo.
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
      TABELA_BOLETOS          = aws_dynamodb_table.boletos.name
      APPSYNC_ENDPOINT        = aws_appsync_graphql_api.principal.uris["GRAPHQL"]
      TIMEOUT_PAGAMENTO_HORAS = tostring(var.timeout_pagamento_horas)
      RITMO_DEMO_SEGUNDOS     = tostring(var.ritmo_demo_segundos)
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

# O alias e o endereco estavel que a API usa. Trocar o alias para uma versao
# nova NAO afeta execucoes em andamento: elas continuam na versao em que
# nasceram.
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
      TABELA_BOLETOS   = aws_dynamodb_table.boletos.name
      APPSYNC_ENDPOINT = aws_appsync_graphql_api.principal.uris["GRAPHQL"]
      ORQUESTRADOR_ARN = aws_lambda_alias.orquestrador.arn
      TOKEN_API        = random_password.token_api.result
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
