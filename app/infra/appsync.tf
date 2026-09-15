# ── AppSync: o canal de tempo real ────────────────────────────────────────────
#
# Duas modalidades de auth no mesmo endpoint:
#   API_KEY (padrao) para o navegador: le e assina, nunca publica.
#   AWS_IAM          para as Lambdas: as unicas que podem publicar.

resource "aws_appsync_graphql_api" "principal" {
  name                = "${local.prefixo}-api"
  authentication_type = "API_KEY"
  schema              = file("${path.module}/schema.graphql")

  additional_authentication_provider {
    authentication_type = "AWS_IAM"
  }

  log_config {
    cloudwatch_logs_role_arn = aws_iam_role.appsync_logs.arn
    field_log_level          = "ERROR"
  }
}

resource "aws_appsync_api_key" "frontend" {
  api_id  = aws_appsync_graphql_api.principal.id
  expires = timeadd(timestamp(), "720h") # 30 dias

  lifecycle {
    # `timestamp()` muda a cada plan; sem isto a chave seria recriada sempre.
    ignore_changes = [expires]
  }
}

# ── Data sources ──────────────────────────────────────────────────────────────

resource "aws_appsync_datasource" "boletos" {
  api_id           = aws_appsync_graphql_api.principal.id
  name             = "tabela_boletos"
  type             = "AMAZON_DYNAMODB"
  service_role_arn = aws_iam_role.appsync_dynamo.arn

  dynamodb_config {
    table_name = aws_dynamodb_table.boletos.name
    region     = local.regiao
  }
}

# Data source vazio: as mutations publish* nao persistem nada, existem so para
# disparar as subscriptions. Quem escreve no DynamoDB e o backend.
resource "aws_appsync_datasource" "local" {
  api_id = aws_appsync_graphql_api.principal.id
  name   = "notificacoes"
  type   = "NONE"
}

# ── Resolvers (runtime APPSYNC_JS) ────────────────────────────────────────────

locals {
  resolvers_dynamo = {
    listBoletos = { tipo = "Query", arquivo = "listBoletos.js" }
    getBoleto   = { tipo = "Query", arquivo = "getBoleto.js" }
    listEvents  = { tipo = "Query", arquivo = "listEvents.js" }
  }
  resolvers_locais = ["publishBoleto", "publishEvent"]
}

resource "aws_appsync_resolver" "dynamo" {
  for_each = local.resolvers_dynamo

  api_id      = aws_appsync_graphql_api.principal.id
  type        = each.value.tipo
  field       = each.key
  data_source = aws_appsync_datasource.boletos.name
  code        = file("${path.module}/resolvers/${each.value.arquivo}")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}

resource "aws_appsync_resolver" "publicacao" {
  for_each = toset(local.resolvers_locais)

  api_id      = aws_appsync_graphql_api.principal.id
  type        = "Mutation"
  field       = each.value
  data_source = aws_appsync_datasource.local.name
  code        = file("${path.module}/resolvers/publish.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}
