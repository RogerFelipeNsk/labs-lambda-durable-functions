resource "aws_apigatewayv2_api" "http" {
  name          = "${local.prefixo}-http"
  protocol_type = "HTTP"

  # O CORS e resolvido aqui, no gateway. A Lambda nao devolve cabecalho de CORS
  # nenhum — se devolvesse, o navegador veria o header duplicado e recusaria.
  cors_configuration {
    allow_origins = var.origens_cors
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type", "x-lab-token"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

locals {
  rotas = [
    "GET /saude",
    "GET /boletos",
    "POST /boletos",
    "GET /boletos/{id}",
    "POST /boletos/{id}/pagar",
    "POST /boletos/{id}/caos",
    "POST /boletos/{id}/parar",
    "GET /boletos/{id}/execucao",
  ]
}

resource "aws_apigatewayv2_route" "rotas" {
  for_each = toset(local.rotas)

  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/aws/apigateway/${local.prefixo}-http"
  retention_in_days = var.retencao_logs_dias
}

resource "aws_apigatewayv2_stage" "padrao" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.gateway.arn
    format = jsonencode({
      requestId = "$context.requestId"
      rota      = "$context.routeKey"
      status    = "$context.status"
      latencia  = "$context.responseLatency"
      erro      = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_lambda_permission" "gateway" {
  statement_id  = "AllowInvokeFromHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
