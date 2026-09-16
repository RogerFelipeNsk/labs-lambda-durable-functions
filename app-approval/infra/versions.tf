terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # durable_config so existe a partir do provider 6.25.0.
      version = ">= 6.25.0"
    }
    local = {
      source  = "hashicorp/local"
      version = ">= 2.5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }
}

provider "aws" {
  region = var.regiao
  # Vazio = usa a cadeia padrao de credenciais (env, SSO, instance profile).
  profile = var.perfil_aws != "" ? var.perfil_aws : null

  default_tags {
    tags = {
      Projeto = var.nome_projeto
      Lab     = "lambda-durable-functions-aprovacao"
      Gestor  = "opentofu"
    }
  }
}
