# Tabela unica. A solicitacao e sua linha do tempo moram na mesma particao
# (pk = SOLICITACAO#<id>), entao carregar uma solicitacao com todo o
# historico e uma Query so. O indice by_created existe apenas para listar do
# mais novo para o mais antigo sem Scan.
resource "aws_dynamodb_table" "solicitacoes" {
  name         = "${local.prefixo}-solicitacoes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "by_created"
    projection_type = "ALL"

    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }

  point_in_time_recovery {
    enabled = false # laboratorio: nao vale o custo
  }
}
