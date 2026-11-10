#!/usr/bin/env bash
# Sobe (ou atualiza) o bot de vagas no servidor. Rode na pasta do repositório, com o
# usuário de trabalho (não root):  bash servidor/instalar.sh
# Na primeira vez cria o .env com uma senha aleatória para o PostgreSQL.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  umask 077
  cp .env.example .env
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
  echo ".env criado com senha nova para o PostgreSQL."
fi
chmod 600 .env
grep -q '^POSTGRES_PASSWORD=.\+' .env || { echo "ERRO: POSTGRES_PASSWORD vazio no .env" >&2; exit 1; }

docker compose pull
docker compose up -d --remove-orphans

printf 'Esperando o PostgreSQL'
for _ in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U vagas -d vagas >/dev/null 2>&1; then break; fi
  printf '.'; sleep 2
done
echo
docker compose exec -T postgres psql -U vagas -d vagas -tAc "SELECT 'tabela vagas ok: ' || count(*) || ' linhas' FROM vagas"
docker compose ps

cat <<'MSG'

No seu Windows, abra o túnel (ssh vagas, ver docs/servidor.md) e acesse http://localhost:5679
Senha do Postgres para a credencial do n8n:  grep POSTGRES_PASSWORD .env
MSG
