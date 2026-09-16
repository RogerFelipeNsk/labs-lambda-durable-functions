variable "perfil_aws" {
  description = <<-DESC
    Perfil do ~/.aws/config usado no deploy. Vazio (padrao) usa a cadeia
    normal de credenciais da AWS. Passe um nome para fixar um perfil:
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
  default     = "lab-aprovacao"
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
    Prazo maximo da execucao durable inteira, da solicitacao ate o pagamento.
    Precisa cobrir o pior caso de escalonamento: gestor nao responde (ate
    prazo_gestor_minutos) + diretoria tambem nao responde (ate
    prazo_diretoria_minutos). O contrato da AWS aceita de 1 a 31.622.400
    segundos (366 dias).
  DESC
  type        = number
  default     = 604800 # 7 dias: cobre 24h (gestor) + 48h (diretoria) com folga

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

variable "limite_automatico_centavos" {
  description = "Abaixo deste valor, a solicitacao e aprovada automaticamente, sem passar por humano."
  type        = number
  default     = 30000 # R$ 300,00
}

variable "limite_financeiro_centavos" {
  description = "A partir deste valor, o financeiro tambem precisa aprovar, em paralelo com o gestor."
  type        = number
  default     = 500000 # R$ 5.000,00
}

variable "prazo_gestor_minutos" {
  description = <<-DESC
    Prazo para o gestor decidir antes de escalar para a diretoria. Baixe para
    1-2 minutos se quiser ver o escalonamento acontecer ao vivo numa demo.
  DESC
  type        = number
  default     = 1440 # 24h
}

variable "prazo_diretoria_minutos" {
  description = "Prazo para a diretoria decidir, apos o escalonamento, antes da solicitacao expirar."
  type        = number
  default     = 2880 # 48h
}

variable "prazo_financeiro_minutos" {
  description = "Prazo para o financeiro decidir (roda em paralelo com o gestor, sem escalonamento)."
  type        = number
  default     = 1440 # 24h
}

variable "ritmo_demo_segundos" {
  description = <<-DESC
    Pausa antes da execucao do pagamento, so para dar tempo de acompanhar a
    timeline na tela. Implementada com `ctx.wait`, que SUSPENDE a execucao —
    aumentar este valor nao custa compute. Use 0 para rodar sem pausa.
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
  description = "Origens liberadas no CORS da API HTTP. O padrao cobre o Vite local (porta 5174, para nao colidir com app/frontend na 5173)."
  type        = list(string)
  default     = ["http://localhost:5174", "http://127.0.0.1:5174"]
}

variable "caminho_zip_backend" {
  description = "Artefato gerado por 'npm run build' no backend. Precisa existir antes do plan."
  type        = string
  default     = "../backend/dist/backend.zip"
}

variable "gerar_env_frontend" {
  description = "Escreve app-approval/frontend/.env.local com os endpoints deste deploy."
  type        = bool
  default     = true
}
