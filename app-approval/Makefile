# Atalhos do laboratorio. Tudo aqui e opcional: sao os mesmos comandos do README.
SHELL := /bin/bash
INFRA := infra
BACK  := backend
FRONT := frontend

# Perfil AWS. O jeito recomendado e criar infra/terraform.tfvars (ignorado pelo
# git) com `perfil_aws = "seu-perfil"`. Para um override pontual:
#   make deploy PERFIL=outro-perfil
PERFIL ?=
TFVAR  := $(if $(PERFIL),-var perfil_aws=$(PERFIL),)

.PHONY: ajuda build deploy dev destroy plano logs limpar

ajuda:
	@echo "build    empacota o backend em $(BACK)/dist/backend.zip"
	@echo "         (use PERFIL=nome para escolher o perfil AWS)"
	@echo "plano    build + tofu plan"
	@echo "deploy   build + tofu apply (gera $(FRONT)/.env.local)"
	@echo "dev      sobe o frontend em http://localhost:5174"
	@echo "logs     acompanha os logs da durable function"
	@echo "destroy  derruba tudo"

build:
	cd $(BACK) && npm install --no-audit --no-fund && npm run build

plano: build
	cd $(INFRA) && tofu init -input=false && tofu plan $(TFVAR)

deploy: build
	cd $(INFRA) && tofu init -input=false && tofu apply $(TFVAR)
	@echo ""
	@echo "Pronto. Agora: make dev"

dev:
	cd $(FRONT) && npm install --no-audit --no-fund && npm run dev

logs:
	aws logs tail "/aws/lambda/$$(cd $(INFRA) && tofu output -raw nome_funcao_orquestrador)" --follow --format short

destroy:
	cd $(INFRA) && tofu destroy $(TFVAR)

limpar:
	rm -rf $(BACK)/dist $(BACK)/node_modules $(FRONT)/dist $(FRONT)/node_modules
