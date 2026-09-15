variable "perfil_aws" {
  description = <<-DESC
    Perfil do ~/.aws/config usado no deploy. Vazio (padrao) usa a cadeia normal
    de credenciais da AWS. Passe um nome para fixar um perfil:
    `tofu apply -var perfil_aws=meu-perfil`
  DESC
  type        = string
  default     = ""
}

variable "regiao" {
  description = "Regiao AWS. Precisa ser uma regiao com Lambda durable functions disponivel."
  type        = string
  default     = "us-east-2"
}

variable "nome_projeto" {
  description = "Prefixo usado no nome de todos os recursos."
  type        = string
  default     = "lab-conciliacao"
}

variable "runtime_lambda" {
  description = "Runtime Node.js. Durable functions suportam nodejs22.x e nodejs24.x."
  type        = string
  default     = "nodejs22.x"

  validation {
    condition     = contains(["nodejs22.x", "nodejs24.x"], var.runtime_lambda)
    error_message = "Durable functions suportam apenas nodejs22.x ou nodejs24.x nesta stack."
  }
}

variable "arquitetura" {
  description = "arm64 e mais barato; troque para x86_64 se precisar de alguma dependencia nativa."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.arquitetura)
    error_message = "Use arm64 ou x86_64."
  }
}

variable "timeout_execucao_segundos" {
  description = <<-DESC
    Prazo maximo da execucao durable inteira, da emissao ate a conciliacao.
    Diferente do timeout da invocacao: uma execucao pode ficar suspensa
    esperando o pagamento por dias e continuar dentro deste limite.
    O contrato da AWS aceita de 1 a 31.622.400 segundos (366 dias).
  DESC
  type        = number
  default     = 345600 # 4 dias: cobre as 72h de espera pelo pagamento com folga

  validation {
    condition     = var.timeout_execucao_segundos >= 1 && var.timeout_execucao_segundos <= 31622400
    error_message = "execution_timeout precisa ficar entre 1 e 31.622.400 segundos."
  }
}

variable "retencao_historico_dias" {
  description = "Por quantos dias o historico da execucao durable fica consultavel (1 a 90)."
  type        = number
  default     = 7

  validation {
    condition     = var.retencao_historico_dias >= 1 && var.retencao_historico_dias <= 90
    error_message = "retention_period precisa ficar entre 1 e 90 dias."
  }
}

variable "timeout_pagamento_horas" {
  description = "Prazo do callback de pagamento. Passou disso, o boleto vence."
  type        = number
  default     = 72
}

variable "ritmo_demo_segundos" {
  description = <<-DESC
    Pausa entre as etapas do workflow, so para dar tempo de acompanhar a
    timeline na tela. Implementada com `ctx.wait`, que SUSPENDE a execucao —
    aumentar este valor nao custa compute, so adia a retomada. Use 0 para
    rodar o fluxo na velocidade maxima.
  DESC
  type        = number
  default     = 6

  validation {
    condition     = var.ritmo_demo_segundos >= 0 && var.ritmo_demo_segundos <= 300
    error_message = "Use entre 0 e 300 segundos."
  }
}

variable "retencao_logs_dias" {
  description = "Retencao dos log groups do CloudWatch."
  type        = number
  default     = 7
}

variable "origens_cors" {
  description = "Origens liberadas no CORS da API HTTP. O padrao cobre o Vite local."
  type        = list(string)
  default     = ["http://localhost:5173", "http://127.0.0.1:5173"]
}

variable "caminho_zip_backend" {
  description = "Artefato gerado por 'npm run build' no backend. Precisa existir antes do plan."
  type        = string
  default     = "../backend/dist/backend.zip"
}

variable "gerar_env_frontend" {
  description = "Escreve app/frontend/.env.local com os endpoints deste deploy."
  type        = bool
  default     = true
}
