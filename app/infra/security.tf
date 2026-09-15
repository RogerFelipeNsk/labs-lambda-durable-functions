# ── Token de acesso da API ────────────────────────────────────────────────────
#
# A API HTTP nao tem autenticacao nativa: sao 8 rotas publicas na internet.
# Sem nada na frente, qualquer um emite cobranca, arma caos e para execucao na
# sua conta — o problema nao e o dado (e ficticio), e a conta de custo.
#
# A protecao aqui e deliberadamente simples: um token compartilhado, gerado no
# apply e conferido pela Lambda. Nao substitui IAM nem Cognito num sistema de
# verdade, mas fecha o acesso anonimo com atrito quase zero — que e o ponto
# certo para um laboratorio.
resource "random_password" "token_api" {
  length  = 40
  special = false
}
