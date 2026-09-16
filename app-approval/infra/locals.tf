data "aws_caller_identity" "atual" {}
data "aws_region" "atual" {}

locals {
  prefixo    = var.nome_projeto
  conta      = data.aws_caller_identity.atual.account_id
  regiao     = data.aws_region.atual.region
  hash_zip   = filebase64sha256(var.caminho_zip_backend)
  nome_orq   = "${local.prefixo}-orquestrador"
  nome_api   = "${local.prefixo}-api"
  arn_funcao = "arn:aws:lambda:${local.regiao}:${local.conta}:function:${local.nome_orq}"

  # Acoes de durable execution sao autorizadas contra o ARN da EXECUCAO, que e
  # um sub-recurso da versao da funcao. Um ARN sem qualificador nunca casa, por
  # isso o ":*" no fim.
  arn_execucoes_durable = "${local.arn_funcao}:*"

  console_durable = "https://${local.regiao}.console.aws.amazon.com/lambda/home?region=${local.regiao}#/functions/${local.nome_orq}?tab=durable"
}
