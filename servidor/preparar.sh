#!/usr/bin/env bash
# Prepara um servidor Ubuntu/Debian novo para rodar o bot de vagas.
# Rode UMA vez, como root, logado com a sua chave SSH (docs/servidor.md, passo 2):
#
#   bash preparar.sh [usuario]        (padrão: bot)
#
# O que faz: atualiza o sistema, liga atualizações automáticas de segurança, cria o usuário
# de trabalho com a sua chave SSH, desliga login por senha e de root, liga o firewall (só
# SSH entra), instala fail2ban e Docker, acerta o fuso e cria swap se a memória for pouca.
# Pode rodar de novo sem estragar nada.
set -euo pipefail

USUARIO="${1:-bot}"
FUSO="America/Sao_Paulo"

passo() { printf '\n==> %s\n' "$*"; }
falha() { printf '\nERRO: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || falha "rode como root (ou com sudo)."
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) falha "sistema '${ID:-?}' não suportado por este script (feito para Ubuntu/Debian)." ;;
esac
# Chaves que vão para o usuário: as do root ou, se entrou com outro usuário + sudo, as dele
CHAVES=/root/.ssh/authorized_keys
if [ ! -s "$CHAVES" ] && [ -n "${SUDO_USER:-}" ]; then
  CHAVES="$(getent passwd "$SUDO_USER" | cut -d: -f6)/.ssh/authorized_keys"
fi
[ -s "$CHAVES" ] || falha "nenhuma chave SSH em $CHAVES: copie a sua chave antes (passo 1 do guia)."

export DEBIAN_FRONTEND=noninteractive

passo "Atualizando o sistema"
apt-get update -q
apt-get -y -q upgrade
apt-get -y -q install ca-certificates curl gnupg git openssl ufw fail2ban python3-systemd unattended-upgrades

passo "Atualizações automáticas de segurança"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

passo "Nome da máquina em /etc/hosts (evita o aviso 'sudo: unable to resolve host')"
getent hosts "$(hostname)" >/dev/null || echo "127.0.1.1 $(hostname)" >> /etc/hosts

passo "Fuso horário: $FUSO"
timedatectl set-timezone "$FUSO" || ln -sf "/usr/share/zoneinfo/$FUSO" /etc/localtime

passo "Usuário de trabalho: $USUARIO"
if ! id "$USUARIO" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$USUARIO"
fi
usermod -aG sudo "$USUARIO"
# Sem senha (o login é só por chave), então o sudo não pede senha para este usuário.
echo "$USUARIO ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$USUARIO"
chmod 440 "/etc/sudoers.d/90-$USUARIO"
visudo -cf "/etc/sudoers.d/90-$USUARIO" >/dev/null
CASA="$(getent passwd "$USUARIO" | cut -d: -f6)"
install -d -m 700 -o "$USUARIO" -g "$USUARIO" "$CASA/.ssh"
touch "$CASA/.ssh/authorized_keys"
# Acrescenta as chaves do root que o usuário ainda não tem
while IFS= read -r chave; do
  [ -n "$chave" ] || continue
  grep -qxF "$chave" "$CASA/.ssh/authorized_keys" || echo "$chave" >> "$CASA/.ssh/authorized_keys"
done < "$CHAVES"
chown "$USUARIO:$USUARIO" "$CASA/.ssh/authorized_keys"
chmod 600 "$CASA/.ssh/authorized_keys"

passo "SSH: só por chave, sem login de root"
# 00- para vir antes do 50-cloud-init.conf (no sshd vale o primeiro valor lido)
cat > /etc/ssh/sshd_config.d/00-endurecimento.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers $USUARIO
X11Forwarding no
MaxAuthTries 3
EOF
mkdir -p /run/sshd
sshd -t || { rm -f /etc/ssh/sshd_config.d/00-endurecimento.conf; falha "configuração do SSH inválida; nada foi alterado no SSH."; }
# Porta(s) do SSH a liberar no firewall. Junta três fontes, porque o provedor pode ligar o
# sshd com a porta na linha de comando (-p), e aí a configuração (sshd -T) diz 22:
#  - a porta pela qual você está conectado agora (a que com certeza funciona);
#  - as portas em que o sshd está escutando de fato;
#  - só se as duas não derem nada, as da configuração.
PORTAS_SSH="$( {
  [ -n "${SSH_CONNECTION:-}" ] && echo "$SSH_CONNECTION" | awk '{print $4}'
  ss -Htlnp 2>/dev/null | awk '/"sshd"/ {n = split($4, a, ":"); print a[n]}'
} | grep -E '^[0-9]+$' | sort -un | xargs )"
[ -n "$PORTAS_SSH" ] || PORTAS_SSH="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' | sort -un | xargs)"
PORTA_ATUAL="$(echo "${SSH_CONNECTION:-}" | awk '{print $4}')"
[ -n "$PORTAS_SSH" ] || falha "não consegui descobrir a porta do SSH; nada foi alterado no firewall."
echo "SSH escuta na(s) porta(s): $PORTAS_SSH"
# No Ubuntu 24.04 o ssh sobe por socket: se não estiver rodando, já lê a config nova ao subir
systemctl try-reload-or-restart ssh 2>/dev/null || systemctl try-reload-or-restart sshd 2>/dev/null || true

passo "Firewall: só SSH entra (porta(s) $PORTAS_SSH)"
ufw default deny incoming
ufw default allow outgoing
for p in $PORTAS_SSH; do ufw allow "$p/tcp"; done
ufw --force enable

passo "fail2ban (bloqueia quem erra o SSH repetidamente)"
cat > /etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled = true
port = $(echo "$PORTAS_SSH" | tr ' ' ',')
backend = systemd
maxretry = 5
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

passo "Docker (repositório oficial)"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# Logs dos containers com tamanho limitado (o padrão cresce sem fim)
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
  systemctl restart docker
fi
systemctl enable --now docker
usermod -aG docker "$USUARIO"

passo "Swap"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$(swapon --noheadings | wc -l)" -eq 0 ] && [ "$MEM_MB" -lt 4096 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap de 2 GB criado (memória: ${MEM_MB} MB)"
else
  echo "não precisa (memória: ${MEM_MB} MB, swap ativo: $(swapon --noheadings | wc -l))"
fi

cat <<EOF

Pronto. ANTES de fechar esta sessão, abra OUTRO PowerShell e teste:

  ssh -p ${PORTA_ATUAL:-${PORTAS_SSH%% *}} $USUARIO@<IP do servidor>

Se entrar, pode sair daqui. Login de root e por senha estão desligados a partir de agora.
EOF
if [ -f /var/run/reboot-required ]; then
  echo "O sistema pede reinício (atualização de kernel): depois do teste, rode 'reboot'."
fi
