# Instalação no servidor

Roteiro para rodar o bot de vagas no seu servidor, com n8n e PostgreSQL em Docker.
**Nada fica exposto na internet** (só o SSH), o n8n é
aberto no seu navegador por um túnel SSH, e os segredos ficam no `.env` do servidor e nas
credenciais do n8n, nunca no repositório.

```
Windows (você)                         Servidor
  navegador → localhost:5679 ══ SSH ══→ n8n (127.0.0.1:5678) ──→ PostgreSQL (rede interna)
                                        firewall: só o SSH entra
```

Tempo estimado: 1 hora na primeira vez. Os comandos marcados **PowerShell** são no seu
Windows, na pasta do repositório (faça `git pull` antes); os marcados **servidor** são
no terminal do servidor, depois do `ssh`.

## 0. O que você vai precisar

- O acesso inicial que o provedor mandou: usuário `root` e senha (ou uma chave).
- O servidor com **Ubuntu 22.04/24.04 ou Debian 12** (o script confere e recusa outros).
- O cliente SSH do Windows (já vem no Windows 10/11; teste com `ssh -V`).
- As chaves do bot: Gemini, token do bot do Telegram e o seu chat id (README, *Instalação*, passo 2).

Nos comandos deste guia, troque `<IP>` pelo endereço do servidor e `<porta>` pela porta do
SSH que o provedor informou (22 é o padrão, mas alguns provedores usam outra). Atenção: no
`ssh` a porta vai com `-p` minúsculo; no `scp`, com `-P` maiúsculo.

## 1. Sua chave SSH no servidor (PowerShell)

Se você ainda não tem uma chave (não existe `%USERPROFILE%\.ssh\id_ed25519`), crie. Aceite
o caminho padrão; a senha da chave é opcional, mas recomendada:

```powershell
ssh-keygen -t ed25519
```

Copie a chave para o `root` do servidor (vai pedir a senha que o provedor mandou e, na
primeira vez, para confirmar a impressão digital do servidor: responda `yes`):

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | ssh -p <porta> root@<IP> "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"
```

Confira que entra sem senha e qual é o sistema:

```powershell
ssh -p <porta> root@<IP> "grep PRETTY_NAME /etc/os-release; free -h; df -h /"
```

Se o provedor não deu `root`, e sim um usuário com `sudo` (ex.: `ubuntu`), troque `root`
por ele nesses comandos; no passo 2 use `scp ... usuario@...:~/` e rode
`ssh -t -p <porta> usuario@<IP> "sudo bash ~/preparar.sh bot"`.

## 2. Preparar o servidor (PowerShell)

O script `servidor/preparar.sh` atualiza o sistema, liga atualizações automáticas de
segurança, cria o usuário `bot` com a sua chave, **desliga login por senha e de root**,
liga o firewall (só a porta do SSH entra; ele descobre sozinho qual é), instala fail2ban e Docker, põe o fuso em São Paulo e cria
swap se a memória for pouca.

```powershell
scp -P <porta> servidor\preparar.sh root@<IP>:/root/; if ($LASTEXITCODE -eq 0) { ssh -p <porta> root@<IP> "bash /root/preparar.sh bot" }
```

**Antes de fechar** essa janela, abra **outro** PowerShell e teste o novo acesso:

```powershell
ssh -p <porta> bot@<IP> "sudo whoami; docker --version"
```

Deve responder `root` e a versão do Docker. Se o script disse que o sistema pede
reinício, rode `ssh -p <porta> bot@<IP> "sudo reboot"` e espere um minuto.

Daqui para frente o acesso é sempre `bot@<IP>`, só com chave. Se perder a chave
do Windows, a volta é pelo console web do provedor.

### Atalho `ssh vagas` com o túnel do n8n

Grave um atalho que já abre o túnel para o n8n na porta **5679** do Windows (a 5678 fica
livre para um n8n local, se houver):

```powershell
Add-Content -Path $env:USERPROFILE\.ssh\config -Value "`nHost vagas`n  HostName <IP>`n  Port <porta>`n  User bot`n  LocalForward 5679 localhost:5678`n  ServerAliveInterval 60"
```

A partir daqui, `ssh vagas` entra no servidor **e** deixa o n8n em
<http://localhost:5679> enquanto a janela estiver aberta.

## 3. Baixar o repositório no servidor (servidor)

Se você usa o repositório público sem mudanças, basta clonar:

```bash
git clone https://github.com/<usuario-do-github>/bot-de-vagas.git ~/bot_vagas
```

Se é um repositório seu e privado (uma cópia com mudanças), o servidor usa uma **chave de
implantação** (deploy key) só de leitura, que vale só para esse repositório: se o servidor
for comprometido, ninguém escreve no GitHub com ela.

```bash
ssh-keygen -t ed25519 -N "" -C "servidor-vagas" -f ~/.ssh/deploy_bot_vagas && cat ~/.ssh/deploy_bot_vagas.pub
```

No GitHub: o seu repositório → **Settings → Deploy keys → Add deploy key**. Cole a
linha que apareceu (começa com `ssh-ed25519`), título `servidor do bot de vagas`, e deixe
**Allow write access desmarcado**. Depois:

```bash
printf 'Host github-bot-vagas\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/deploy_bot_vagas\n  IdentitiesOnly yes\n' >> ~/.ssh/config && chmod 600 ~/.ssh/config && ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts && git clone git@github-bot-vagas:<usuario-do-github>/bot-de-vagas.git ~/bot_vagas
```

## 4. Subir n8n e PostgreSQL (servidor)

```bash
cd ~/bot_vagas && bash servidor/instalar.sh
```

Na primeira vez ele cria o `.env` com uma senha aleatória para o banco, baixa as imagens,
sobe os dois containers e cria a tabela `vagas` (a partir do `schema.sql`). Deve terminar
com `tabela vagas ok: 0 linhas` e os dois serviços `running`/`healthy`.

Anote a senha do banco para o passo 6:

```bash
grep POSTGRES_PASSWORD ~/bot_vagas/.env
```

## 5. Abrir o n8n (PowerShell)

Com `ssh vagas` aberto numa janela, abra <http://localhost:5679> e crie o **usuário dono**
(e-mail e senha do n8n do servidor). Se a página não abrir, confira se a janela do
`ssh vagas` continua conectada.

## 6. Sua configuração e credenciais no n8n

A configuração (perfil, termos de busca, sites, empresas, nota de corte, horários) fica em
`~/bot_vagas/config/`, fora do git. Na primeira vez, o `configurar_n8n.sh` abaixo copia o
exemplo para lá e para; edite os dois arquivos (explicação no README, seção
*Configuração*), confira e rode o script de novo:

```bash
cd ~/bot_vagas && nano config/config.json && nano config/perfil.md && python3 configuracao.py
```

No `nano`: Ctrl+O e Enter salvam, Ctrl+X sai.

**Jeito rápido (recomendado):** no servidor, rode

```bash
cd ~/bot_vagas && bash servidor/configurar_n8n.sh
```

Ele pergunta a chave do Gemini, o token e o chat id do Telegram (cole com o botão direito;
o que você cola não aparece), cria as credenciais Postgres, Gemini e Telegram e importa o
workflow (gerado pelo `build.py` a partir da sua configuração) já ligado a elas e
publicado. Rodar de novo atualiza, sem duplicar, e não pergunta nada: as
credenciais que já existem são mantidas. Para trocar uma chave, use
`bash servidor/configurar_n8n.sh --trocar` (Enter em branco mantém aquela credencial).
Com faturamento ativo no Google, `bash servidor/configurar_n8n.sh --faturamento sim` deixa a
análise mais rápida (5 pedidos ao Gemini por segundo em vez de 1 a cada 6 s); `--faturamento nao`
volta ao ritmo do plano gratuito.

**Jeito manual:** gere o arquivo com `python3 build.py` e importe o `workflow.json`
(**Workflows → ⋯ → Import from File**). Ele não traz segredos, então os nós vêm sem
credencial. Crie cada uma e selecione nos nós (a lista de nós está no README, seção *Outro n8n*):

| Credencial | Preenchimento |
|---|---|
| **Postgres** | Host `postgres`, Database `vagas`, User `vagas`, Password = a do `.env`, Port `5432`, SSL `disable` |
| **Header Auth** (Gemini) | Name `x-goog-api-key`, Value = chave do Gemini |
| **Telegram API** | Access Token = token do bot. No nó *Telegram: enviar*, troque `SEU_CHAT_ID` pelo seu chat id |

## 7. Testar e ligar

1. No n8n, rode à mão, na ordem, cada gatilho (botão de play): *Coletar* → *Analisar* →
   *Resumo*, e confira o Telegram.
2. Veja o que entrou no banco (servidor):

   ```bash
   cd ~/bot_vagas && docker compose exec postgres psql -U vagas -d vagas -c "SELECT fonte, status, count(*) FROM vagas GROUP BY 1, 2 ORDER BY 1, 2"
   ```

3. Clique em **Publish** no workflow (no n8n 2.x é o que liga os agendamentos).

## 8. Backup automático (servidor)

`servidor/backup.sh` guarda o banco (`pg_dump`), os dados do n8n (workflows, credenciais
criptografadas e a chave que as abre) e a sua configuração (`config/`) em
`~/backups/bot-vagas`, mantendo 14 dias. Teste e
agende para as 03:10, quando nenhum gatilho roda:

```bash
cd ~/bot_vagas && bash servidor/backup.sh && (crontab -l 2>/dev/null; echo "10 3 * * * $HOME/bot_vagas/servidor/backup.sh >> $HOME/backups/backup.log 2>&1") | crontab -
```

O backup fica **no mesmo servidor**: se a máquina sumir, ele vai junto. De vez em quando
traga uma cópia para o Windows (PowerShell):

```powershell
scp -P <porta> -r bot@<IP>:backups .\backups-servidor
```

O `.tgz` do n8n contém a chave que abre as credenciais: guarde-o como guardaria uma senha.

## 9. Anotações da sua instalação (opcional)

Este guia usa `<IP>` e `<porta>` no lugar dos seus dados, e o repositório não guarda nada
da sua instalação. Para não perder o IP, a porta, o provedor e o que já deu problema (e
para o Claude saber disso ao trabalhar no projeto), anote-os num destes lugares:

- **No seu computador:** um `CLAUDE.local.md` na pasta do repositório (o Claude Code lê
  sozinho) e, se quiser outros arquivos, a pasta `local/`. Os dois estão no `.gitignore`:
  nunca vão para o GitHub. Só servem no seu computador: uma sessão do Claude na nuvem
  não os vê, e se perder o computador, perde as anotações.
- **Num repositório privado à parte**, de nome genérico (ex.: `configuracoes`), com uma
  pasta por projeto com o nome do repositório: aqui, `bot-de-vagas/CLAUDE.md`. Serve também
  para outros projetos e funciona nas sessões na nuvem (inclua os dois repositórios).

Exemplo do conteúdo:

```markdown
# bot-de-vagas: meu servidor

| Item | Valor |
|---|---|
| Máquina | <provedor>, IP `<IP>`, Ubuntu 22.04, 4 GB de RAM |
| SSH | porta `<porta>`, usuário `bot`, só chave |
| Acesso | `ssh vagas` (atalho do passo 2) |

- O que já deu problema e como saí dele.
```

Nada de senha, chave ou token aí: segredos ficam só no `.env` do servidor e nas
credenciais do n8n. A sua configuração (`config/`) também não: ela fica no servidor e
entra no backup do passo 8.

## Comandos úteis (servidor, em `~/bot_vagas`)

| Para | Comando |
|------|---------|
| Ver os containers | `docker compose ps` |
| Logs do n8n | `docker compose logs -f --tail 100 n8n` |
| Logs dos comandos do Telegram | `docker compose logs -f --tail 100 telegram` |
| Atualizar depois de mudanças no repositório | `git pull && bash servidor/instalar.sh && bash servidor/configurar_n8n.sh` |
| Conferir a configuração (`config/`) | `python3 configuracao.py` |
| Aplicar mudança na configuração | `bash servidor/configurar_n8n.sh` |
| Abrir o banco | `docker compose exec postgres psql -U vagas -d vagas` |
| Diagnóstico da coleta (banco, cada fonte testada agora, últimas execuções do n8n por nó) | `bash servidor/diagnostico.sh` |
| Vagas recusadas (nota abaixo do corte) com o motivo | `bash servidor/recusadas.sh 7` (dias; `--csv` grava em `~/relatorios`) |
| Buscar de novo as vagas mais antigas (até 30 dias) | mande `/buscar 30` ao bot (`/buscar 3` = últimos 3 dias) |
| Aplicar mudança no `schema.sql` (comandos `IF NOT EXISTS`) | `docker compose exec -T postgres psql -U vagas -d vagas < schema.sql` |
| Reiniciar tudo | `docker compose restart` |
| Parar tudo (mantém os dados) | `docker compose down` |
| Restaurar o banco de um backup | `docker compose exec -T postgres pg_restore -U vagas -d vagas --clean < ~/backups/bot-vagas/vagas_<data>.dump` |
| Espaço em disco e memória | `df -h /; free -h; docker system df` |
| IPs bloqueados pelo fail2ban | `sudo fail2ban-client status sshd` |

**Nunca rode `docker compose down -v`**: o `-v` apaga os volumes (banco e n8n).

## Problemas comuns

| Sintoma | Causa provável |
|---------|----------------|
| `Connection timed out` na porta do SSH logo depois do `preparar.sh` | o firewall não liberou a porta: no console do provedor (como `root`), `ufw allow <porta>/tcp` |
| `Connection refused` | porta errada: confira o `-p <porta>` (ou `-P <porta>` no `scp`) com a porta do SSH que o provedor informou |
| `Permission denied (publickey)` | chave errada ou usuário errado: o acesso é `bot@`, não `root@` |
| `ssh vagas` entra, mas <http://localhost:5679> não abre | outra janela já usa a porta 5679, ou o túnel caiu: feche e abra o `ssh vagas` de novo |
| `$'\r': command not found` ao rodar o script | o arquivo foi salvo com fim de linha do Windows: `git pull` (o `.gitattributes` corrige) e copie de novo |
| Credencial Postgres falha com *ECONNREFUSED* | host errado: é `postgres` (nome do serviço), não `localhost` |
| Resumo "Nenhuma vaga nova" | a mensagem diz quantas foram coletadas e quantas aguardam análise; detalhes com `bash servidor/recusadas.sh` (seção "Situação geral") |
| Nenhuma vaga do LinkedIn | veja o log do nó *LinkedIn: buscar* na execução (*Executions*): `falha na busca` com 429/999 é bloqueio do LinkedIn ao IP do servidor |
| `docker: permission denied` logo após o passo 2 | saia e entre de novo no SSH (o grupo `docker` vale a partir do próximo login) |
