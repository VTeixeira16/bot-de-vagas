#!/usr/bin/env bash
# Cópia do banco de vagas (pg_dump), dos dados do n8n (workflows, credenciais
# criptografadas e a chave que as abre) e da sua configuração (config/, que não está no
# git). Guarda em ~/backups/bot-vagas e apaga as com
# mais de 14 dias. Agendado pelo cron às 03:10 (docs/servidor.md), quando nada roda.
set -euo pipefail
cd "$(dirname "$0")/.."

DESTINO="${DESTINO:-$HOME/backups/bot-vagas}"
DIAS="${DIAS:-14}"
AGORA="$(date +%Y-%m-%d_%H%M)"
# Arquivos novos só legíveis por este usuário desde a criação (o n8n_*.tgz tem a chave que
# abre as credenciais)
umask 077
mkdir -p "$DESTINO"
chmod 700 "$DESTINO"

# Grava num .tmp e só renomeia no fim: um pg_dump que falhe no meio não deixa um backup
# parcial com cara de bom
docker compose exec -T postgres pg_dump -U vagas -d vagas --format=custom \
  > "$DESTINO/vagas_$AGORA.dump.tmp"
mv "$DESTINO/vagas_$AGORA.dump.tmp" "$DESTINO/vagas_$AGORA.dump"

# O volume do n8n pertence ao usuário do container; lê como root dentro de um container
# descartável (imagem do postgres, já baixada) e devolve o arquivo para este usuário.
IMAGEM="$(docker compose config --images | grep postgres | head -1)"
docker run --rm -v bot-vagas_dados_n8n:/dados:ro -v "$DESTINO":/saida "$IMAGEM" \
  sh -c "umask 077 && tar czf /saida/n8n_$AGORA.tgz -C /dados . && chown $(id -u):$(id -g) /saida/n8n_$AGORA.tgz"

if [ -d config ]; then
  tar czf "$DESTINO/config_$AGORA.tgz" config
fi

chmod 600 "$DESTINO"/*_"$AGORA".*
find "$DESTINO" -type f -name '*.tmp' -delete
find "$DESTINO" -type f -mtime +"$DIAS" -delete
echo "backup ok: $(find "$DESTINO" -type f | wc -l) arquivos em $DESTINO"
