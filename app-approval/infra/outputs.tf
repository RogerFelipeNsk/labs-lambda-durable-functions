output "api_url" {
  description = "Base da API HTTP. Ex.: curl \"$(tofu output -raw api_url)/saude\""
  value       = aws_apigatewayv2_stage.padrao.invoke_url
}

output "token_api" {
  description = "Token exigido no header x-lab-token pelas rotas da API."
  value       = random_password.token_api.result
  sensitive   = true
}

output "appsync_endpoint" {
  description = "Endpoint GraphQL do AppSync."
  value       = aws_appsync_graphql_api.principal.uris["GRAPHQL"]
}

output "appsync_api_key" {
  description = "API key de leitura usada pelo frontend."
  value       = aws_appsync_api_key.frontend.key
  sensitive   = true
}

output "orquestrador_alias_arn" {
  description = "ARN qualificado da durable function. E por ele que a execucao comeca."
  value       = aws_lambda_alias.orquestrador.arn
}

output "orquestrador_versao" {
  description = "Versao publicada. Execucoes em andamento ficam presas a versao em que nasceram."
  value       = aws_lambda_function.orquestrador.version
}

output "nome_funcao_orquestrador" {
  description = "Nome da durable function, util para 'aws logs tail' e para o script de historico."
  value       = aws_lambda_function.orquestrador.function_name
}

output "tabela_solicitacoes" {
  description = "Nome da tabela do DynamoDB."
  value       = aws_dynamodb_table.solicitacoes.name
}

output "console_execucoes_durable" {
  description = "Aba 'Durable executions' da funcao no console da AWS."
  value       = local.console_durable
}

output "proximos_passos" {
  description = "O que fazer depois do apply."
  value       = <<-TXT
    1. cd ../frontend && npm install && npm run dev
    2. abra http://localhost:5174  (o token da API ja foi para o .env.local)
    3. solicite uma compra acima de R$ 300 e acompanhe "aguardando gestor"
    4. clique em Aprovar/Rejeitar na propria tela — isso resolve o waitForCallback
    5. compare com a aba "Durable executions" no console: ${local.console_durable}
  TXT
}

# Entrega os endpoints prontos para o Vite, para nao precisar copiar output na mao.
resource "local_file" "env_frontend" {
  count = var.gerar_env_frontend ? 1 : 0

  filename        = "${path.module}/../frontend/.env.local"
  file_permission = "0600"
  content         = <<-ENV
    # Gerado pelo OpenTofu. Nao edite: rode 'tofu apply' para regenerar.
    VITE_API_URL=${aws_apigatewayv2_stage.padrao.invoke_url}
    VITE_API_TOKEN=${random_password.token_api.result}
    VITE_APPSYNC_ENDPOINT=${aws_appsync_graphql_api.principal.uris["GRAPHQL"]}
    VITE_APPSYNC_API_KEY=${aws_appsync_api_key.frontend.key}
    VITE_AWS_REGION=${local.regiao}
  ENV
}
