# ── Token de acesso da API ────────────────────────────────────────────────────
#
# A API HTTP nao tem autenticacao nativa: sao rotas publicas na internet.
# Sem nada na frente, qualquer um cria solicitacao, decide aprovacoes de
# qualquer valor, arma caos e para execucao na sua conta. A protecao aqui e
# deliberadamente simples: um token compartilhado, gerado no apply e conferido
# pela Lambda. Ver app/infra/security.tf para a explicacao completa.
resource "random_password" "token_api" {
  length  = 40
  special = false
}
