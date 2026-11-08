#!/usr/bin/env bash
# Gera o workflow a partir da sua configuração (config/config.json e config/perfil.md, fora
# do git), cria no n8n do servidor as credenciais (Postgres, Gemini, Telegram) e importa o
# workflow já ligado a elas e com o seu chat id. Rode na pasta do repositório, no servidor:
#
#   bash servidor/configurar_n8n.sh              (mantém as credenciais que já existem)
#   bash servidor/configurar_n8n.sh --trocar     (pergunta tudo de novo, para trocar chaves)
#   bash servidor/configurar_n8n.sh --faturamento sim   (Gemini mais rápido; "nao" volta ao gratuito)
#
# Só pergunta o que ainda não existe no n8n: na primeira vez, a chave do Gemini, o token e
# o chat id do Telegram (o que você digita não aparece); depois, nada. A senha do Postgres
# vem do .env e o chat id fica guardado no .env. Os segredos vão direto para dentro do
# container, sem arquivo no servidor, e o arquivo temporário lá dentro é apagado no fim.
# No fim publica o workflow (liga os horários) e reinicia o n8n para valer.
# O token do Telegram também vai para o .env (TELEGRAM_TOKEN): o container telegram, que lê
# os comandos (/vagas, /buscar...), precisa dele. Se a credencial já existia, o token é lido
# dela, sem perguntar de novo.
set -euo pipefail
cd "$(dirname "$0")/.."

TROCAR=nao
FATURAMENTO_NOVO=""
USO="uso: bash servidor/configurar_n8n.sh [--trocar] [--faturamento sim|nao]"
while [ $# -gt 0 ]; do
  case "$1" in
    --trocar) TROCAR=sim ;;
    --faturamento)
      case "${2:-}" in
        sim|nao) FATURAMENTO_NOVO="$2"; shift ;;
        *) echo "$USO" >&2; exit 1 ;;
      esac ;;
    *) echo "$USO" >&2; exit 1 ;;
  esac
  shift
done

[ -f .env ] || { echo "ERRO: .env não existe; rode antes: bash servidor/instalar.sh" >&2; exit 1; }

# Sua configuração fica em config/ (fora do git; o git pull não mexe nela). Na primeira vez,
# parte do exemplo e para, para você editar antes de importar.
if [ ! -f config/config.json ]; then
  mkdir -p config
  cp exemplo/config.json config/
  [ -f config/perfil.md ] || cp exemplo/perfil.md config/
  cat <<'MSG' >&2
Criei config/config.json e config/perfil.md a partir do exemplo. Edite os dois com os seus
dados (nano config/config.json; nano config/perfil.md; explicação no README, seção
Configuração) e rode este script de novo.
MSG
  exit 1
fi
# Confere a configuração (para aqui, com a explicação, se houver erro) e gera o workflow.json
python3 build.py

# Faturamento do Gemini (não é segredo): com "sim", o nó do Gemini manda vários pedidos de
# uma vez; sem ele (padrão), 1 a cada 6 s, dentro do plano gratuito. Fica guardado no .env.
if [ -n "$FATURAMENTO_NOVO" ]; then
  sed -i '/^GEMINI_FATURAMENTO=/d' .env && echo "GEMINI_FATURAMENTO=$FATURAMENTO_NOVO" >> .env
fi
GEMINI_FATURAMENTO="$(grep '^GEMINI_FATURAMENTO=' .env | cut -d= -f2- || true)"
if [ "$GEMINI_FATURAMENTO" = sim ]; then
  echo "Gemini: faturamento ativo, vários pedidos de uma vez (para voltar: --faturamento nao)."
else
  echo "Gemini: plano gratuito, 1 pedido a cada 6 s (com faturamento: --faturamento sim)."
fi
docker compose exec -T n8n true 2>/dev/null || { echo "ERRO: o n8n não está rodando (docker compose ps)" >&2; exit 1; }

limpar() { docker compose exec -T n8n rm -f /tmp/credenciais.json /tmp/workflow.json /tmp/existentes.json /tmp/telegram.json 2>/dev/null || true; }
trap limpar EXIT

# IDs das credenciais que já existem no n8n (a lista vem com os dados criptografados;
# só o id é lido, e o arquivo é apagado no fim)
EXISTENTES=""
if docker compose exec -T n8n n8n export:credentials --all --output=/tmp/existentes.json >/dev/null 2>&1; then
  EXISTENTES="$(docker compose exec -T n8n cat /tmp/existentes.json \
    | python3 -c 'import json, sys; print(" ".join(c["id"] for c in json.load(sys.stdin)))' || true)"
fi
existe() { [ "$TROCAR" = nao ] && [[ " $EXISTENTES " == *" $(python3 servidor/n8n_montar.py id-credencial "$1") "* ]]; }

POSTGRES_PASSWORD="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
# Segredo do webhook de comandos (o container telegram manda no cabeçalho; o n8n confere).
# Gerado uma vez e guardado no .env; com --trocar, gera outro.
N8N_COMANDO_SEGREDO="$(grep '^N8N_COMANDO_SEGREDO=' .env | cut -d= -f2- || true)"
if [ -z "$N8N_COMANDO_SEGREDO" ] || [ "$TROCAR" = sim ]; then
  N8N_COMANDO_SEGREDO="$(openssl rand -hex 32)"
  sed -i '/^N8N_COMANDO_SEGREDO=/d' .env && echo "N8N_COMANDO_SEGREDO=$N8N_COMANDO_SEGREDO" >> .env
  echo "Comandos: segredo novo do webhook guardado no .env."
fi
GEMINI_KEY=""; TELEGRAM_TOKEN=""
TELEGRAM_CHAT_ID="$(grep '^TELEGRAM_CHAT_ID=' .env | cut -d= -f2- || true)"

if existe httpHeaderAuth; then
  echo "Gemini: mantendo a credencial atual."
else
  read -rsp "Chave do Gemini (cole e Enter; não aparece): " GEMINI_KEY; echo
fi
if existe telegramApi; then
  echo "Telegram: mantendo a credencial atual."
else
  read -rsp "Token do bot do Telegram (cole e Enter; não aparece): " TELEGRAM_TOKEN; echo
fi
if [ -z "$TELEGRAM_CHAT_ID" ] || [ "$TROCAR" = sim ]; then
  read -rp "Seu chat id do Telegram (número; Enter = manter): " NOVO_CHAT_ID
  NOVO_CHAT_ID="$(echo "$NOVO_CHAT_ID" | tr -d '[:space:]')"
  if [ -n "$NOVO_CHAT_ID" ]; then
    [[ "$NOVO_CHAT_ID" =~ ^-?[0-9]+$ ]] || { echo "ERRO: o chat id é só número (pode começar com -)." >&2; exit 1; }
    TELEGRAM_CHAT_ID="$NOVO_CHAT_ID"
    # Guardado no .env para as próximas vezes (o .env não vai para o GitHub)
    sed -i '/^TELEGRAM_CHAT_ID=/d' .env && echo "TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID" >> .env
  fi
else
  echo "Chat id: $TELEGRAM_CHAT_ID (do .env)."
fi
[ -n "$TELEGRAM_CHAT_ID" ] || { echo "ERRO: informe o chat id (na primeira vez é obrigatório)." >&2; exit 1; }

# Token para o container telegram: o que acabou de ser digitado, o do .env ou o da
# credencial que já existe no n8n (exportada decifrada para um arquivo temporário apagado logo)
TOKEN_ENV="$(grep '^TELEGRAM_TOKEN=' .env | cut -d= -f2- || true)"
TOKEN_RELAY="${TELEGRAM_TOKEN:-$TOKEN_ENV}"
if [ -z "$TOKEN_RELAY" ]; then
  ID_TG="$(python3 servidor/n8n_montar.py id-credencial telegramApi)"
  # O token vai só para o arquivo dentro do container; a tela mostra apenas mensagens do n8n
  if docker compose exec -T n8n n8n export:credentials --id="$ID_TG" --decrypted --output=/tmp/telegram.json >/dev/null; then
    TOKEN_RELAY="$(docker compose exec -T n8n cat /tmp/telegram.json | python3 -c '
import json, sys
d = json.load(sys.stdin)
d = d[0] if isinstance(d, list) else d
dados = d.get("data") or {}
if isinstance(dados, str):
    dados = json.loads(dados)
print(dados.get("accessToken", ""))' || true)"
  fi
  docker compose exec -T n8n rm -f /tmp/telegram.json
  if [ -z "$TOKEN_RELAY" ]; then
    echo "Não consegui ler o token da credencial do n8n."
    read -rsp "Token do bot do Telegram, para os comandos (cole e Enter; não aparece): " TOKEN_RELAY; echo
    TOKEN_RELAY="$(echo "$TOKEN_RELAY" | tr -d '[:space:]')"
  fi
fi
if [ -n "$TOKEN_RELAY" ] && [ "$TOKEN_RELAY" != "$TOKEN_ENV" ]; then
  [[ "$TOKEN_RELAY" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || { echo "ERRO: o token do Telegram tem o formato 123456:ABC-..." >&2; exit 1; }
  sed -i '/^TELEGRAM_TOKEN=/d' .env && echo "TELEGRAM_TOKEN=$TOKEN_RELAY" >> .env
  echo "Token do Telegram guardado no .env (para os comandos)."
fi
[ -n "$TOKEN_RELAY" ] || echo "AVISO: sem token do Telegram; os comandos ficam desligados." >&2

export POSTGRES_PASSWORD GEMINI_KEY TELEGRAM_TOKEN TELEGRAM_CHAT_ID GEMINI_FATURAMENTO N8N_COMANDO_SEGREDO

no_container() { docker compose exec -T n8n sh -c "umask 077; cat > $1"; }

python3 servidor/n8n_montar.py credenciais | no_container /tmp/credenciais.json
docker compose exec -T n8n n8n import:credentials --input=/tmp/credenciais.json

python3 servidor/n8n_montar.py workflow | no_container /tmp/workflow.json
docker compose exec -T n8n n8n import:workflow --input=/tmp/workflow.json

# Outro workflow "Bot de vagas" com ID diferente (de uma versão antiga deste script, ou
# importado à mão) dispararia nos mesmos horários e brigaria pelo mesmo webhook: despublica
ID_WF="$(python3 servidor/n8n_montar.py id)"
OUTROS="$(docker compose exec -T n8n n8n list:workflow 2>/dev/null \
  | awk -F'|' -v id="$ID_WF" '$1 ~ /^[A-Za-z0-9]+$/ && $1 != id && $2 ~ /^Bot de vagas/ {print $1}' || true)"
for outro in $OUTROS; do
  docker compose exec -T n8n n8n unpublish:workflow --id="$outro" >/dev/null
  echo "AVISO: o workflow $outro (outro \"Bot de vagas\") foi despublicado; apague-o no n8n (http://localhost:5679)."
done

# Importar sempre despublica: publica de novo e reinicia o n8n para os horários valerem
docker compose exec -T n8n n8n publish:workflow --id="$ID_WF"
limpar
docker compose restart n8n
# Recria sempre o container dos comandos: ele lê o token e o chat id do .env só ao ser
# criado. Sem as variáveis exportadas acima: o compose prefere as do shell às do .env, e o
# TELEGRAM_TOKEN exportado fica vazio quando a credencial já existia.
env -u TELEGRAM_TOKEN -u TELEGRAM_CHAT_ID -u POSTGRES_PASSWORD -u GEMINI_KEY -u GEMINI_FATURAMENTO -u N8N_COMANDO_SEGREDO \
  docker compose up -d --force-recreate telegram
sleep 5
docker compose logs --tail 3 telegram
if ! docker compose exec -T telegram sh -c 'test -n "$TELEGRAM_TOKEN" && test -n "$TELEGRAM_CHAT_ID" && test -n "$N8N_COMANDO_SEGREDO"'; then
  echo "ERRO: o container telegram subiu sem token, chat id ou segredo dos comandos; confira o .env." >&2
  exit 1
fi
echo "Comandos do Telegram: container com token, chat id e segredo do webhook."

# Perfil mandado em PDF pelo Telegram (e confirmado com /usar) vale no lugar do config/perfil.md
PERFIL_PDF="$(docker compose exec -T postgres psql -U vagas -d vagas -XtAc \
  "SELECT to_char(max(criado_em), 'DD/MM/YYYY HH24:MI') FROM perfis WHERE status = 'ativo'" 2>/dev/null || true)"
if [ -n "$PERFIL_PDF" ]; then
  echo "Perfil: está valendo o do currículo mandado no Telegram em $PERFIL_PDF, não o config/perfil.md"
  echo "        (para voltar ao arquivo, mande /perfil arquivo ao bot)."
fi

cat <<'MSG'

Pronto. O workflow "Bot de vagas" está publicado, com Postgres, Gemini e Telegram.
Em uns 30 segundos o n8n volta; para conferir, abra http://localhost:5679 (com o ssh vagas
aberto). Se você tinha importado o workflow.json à mão antes, apague essa cópia.
Comandos no Telegram: mande /ajuda ao bot (log: docker compose logs -f telegram).
MSG
