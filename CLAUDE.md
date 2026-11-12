# Instruções do projeto

Bot de vagas: workflow do n8n (coleta → nota com Gemini → resumo no Telegram) com
PostgreSQL, rodando num servidor (VPS) do usuário. Visão geral no `README.md`; passo a
passo da instalação em `docs/servidor.md`. Esta página é o estado atual do projeto:
atualize-a quando mudar horários, fontes, modelo ou o jeito de aplicar mudanças.

O que é de uma instalação específica (IP, porta, provedor, configuração real e decisões
do usuário) **não fica neste repositório**. As anotações do usuário sobre a instalação
dele (`docs/servidor.md`, passo 9) complementam esta página e valem para ela: um
`CLAUDE.local.md` (e a pasta `local/`) no computador dele, fora do git, ou a pasta
`bot-de-vagas/` de um repositório privado de configurações anexado à sessão. Nunca copie
nada delas para este repositório.

## Regras

- **Segredos só no `.env` do servidor e nas credenciais do n8n.** Nada de chave, token,
  senha ou chat id em `workflow.json`, `src/`, docs ou neste arquivo. O n8n não lê
  variáveis de ambiente (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`).
- **Nada exposto na internet.** n8n e PostgreSQL só em `127.0.0.1`/rede interna do compose;
  acesso pelo túnel SSH. O firewall do servidor só libera a porta do SSH.
- **Nenhum login em site de vagas e nenhuma ação na conta do usuário**; a candidatura é dele.
  No LinkedIn, só as páginas públicas (sem login).
- A versão do n8n no `docker-compose.yml` é fixa (tag + digest): atualize os dois juntos.
- **Nada pessoal no código** (o repositório é público): perfil, termos, buscas, empresas,
  filtros, região, nota de corte e horários ficam em `config/config.json` e
  `config/perfil.md`, fora do git (`.gitignore`), lidos e conferidos pelo `configuracao.py`
  (padrões em `PADRAO`; opção nova precisa de padrão para não quebrar a configuração de
  ninguém). O exemplo fictício fica em `exemplo/`; a configuração de teste, em
  `tests/config/`. Nos documentos, dados de servidor são placeholders (`<IP>`, `<porta>`).
- `workflow.json` é gerado e fica fora do git: o `configurar_n8n.sh` roda o `build.py` no
  servidor com o `config/` de lá. Edite `src/`, `prompt.md` (modelo; os `{{campos}}` vêm
  de `avaliacao`) ou `build.py`. Nunca edite o `workflow.json` à mão nem peça ao usuário para mudar
  nós pelo navegador (a próxima importação desfaz).

## Servidor

| Item | Valor |
|---|---|
| Sistema | Ubuntu 22.04/24.04 ou Debian 12, preparado pelo `servidor/preparar.sh` (usuário `bot` com sudo e grupo `docker`, só chave, sem root, ufw só na porta do SSH, fail2ban, fuso America/Sao_Paulo, atualizações automáticas de segurança, swap se faltar memória) |
| Repositório | `~/bot_vagas` no servidor |
| Docker | projeto compose `bot-vagas`: `n8n` (2.44.6), `postgres` (16-alpine) e `telegram` (python:3.12-alpine, lê os comandos); volumes `bot-vagas_dados_n8n` e `bot-vagas_dados_postgres`; só a rede interna do compose |
| n8n | `127.0.0.1:5678` no servidor; no computador do usuário, `http://localhost:5679` pelo túnel (`N8N_EDITOR_BASE_URL`); `N8N_RUNNERS_TASK_TIMEOUT=7200`; `N8N_SSRF_PROTECTION_ENABLED=true` (recusa pedidos HTTP a IPs internos) |
| Banco | PostgreSQL, banco/usuário `vagas`, tabela criada pelo `schema.sql` na primeira subida |
| `config/` (servidor) | `config.json` e `perfil.md` do usuário, fora do git |
| `.env` (servidor) | `POSTGRES_PASSWORD` (gerada pelo `instalar.sh`), `TELEGRAM_CHAT_ID` e `TELEGRAM_TOKEN` (gravados pelo `configurar_n8n.sh`; o token é lido da credencial do n8n se já existir), `N8N_COMANDO_SEGREDO` (gerado pelo `configurar_n8n.sh`; novo com `--trocar`) e, se ligado, `GEMINI_FATURAMENTO` |
| Backup | `servidor/backup.sh` → `~/backups/bot-vagas` (banco, n8n e `config/`; 14 dias); cron às 03:10, se o usuário tiver agendado (passo 8 do guia) |

O guia cria o atalho `ssh vagas` (porta do SSH, usuário `bot` e `LocalForward 5679
localhost:5678`): a mesma janela abre o terminal do servidor e o túnel do n8n.

Cuidados gerais:
- **Firewall e porta:** alguns provedores passam a porta do SSH na inicialização do sshd, e
  o `sshd -T` mostra 22 mesmo assim. A porta real é a da conexão atual/`ss` (o
  `preparar.sh` libera essa); um `ufw` que libere só a 22 tranca o usuário fora (saída pelo
  console web do provedor).
- **PowerShell 5.1 tira aspas duplas internas** de `ssh host "..."`. Para comandos com
  aspas, peça ao usuário para entrar com `ssh vagas` e colar o comando lá dentro.

## Fluxo do bot

| Quando | O quê |
|---|---|
| 07:00 e 19:00 | Coleta: LinkedIn (`linkedin_buscas` no config, via `jobs-guest` sem login, padrão Brasil por `geoId=106057199` — `location=Brasil` não é reconhecido e devolve vagas dos EUA, conferido em 06/11/2026 — + últimas 24 h; só segue o título que passa no `tituloDeInteresse`), Gupy (também pelo `tituloDeInteresse`; `cargos` + `assuntos` de `termos_de_busca` no config; endereços da API em `src/gupy_buscar.js`, hoje `portal.gupy.io/api/job-search/jobs`; os antigos `portal.api.gupy.io` e `employability-portal.gupy.io` dão 404), Remotive e, num nó só que roda tudo em paralelo (*Sites e carreiras: buscar*, `src/fontes_novas.js`; o n8n roda os ramos um depois do outro), os sites brasileiros em `src/sites_buscar.js` (InfoJobs, Catho, Vagas.com por HTML; Remotar e Trampos por API; termos = `termos_de_busca.cargos`, filtro de título `tituloDeInteresse` com o `filtro_titulo` do config; descrição lida depois pelo JobPosting da página da vaga) e as páginas de carreira em `src/carreiras_buscar.js` (Greenhouse, Lever e Workable por API pública; empresas em `paginas_de_carreira` no config; filtro de local `localDeInteresse` (`locais_de_interesse`) + o mesmo `tituloDeInteresse`, que fica em `src/filtro_titulo.js` e vale para todas as fontes). Horários, nota de corte (padrão 70) e limite (padrão 20) vêm de `horarios` e `resumo` no config; fonte com `false` em `fontes` some da coleta, do `/buscar` e do `/ajuda` |
| Banco vazio | O aviso "no ar" (e o `/status`) pergunta se busca as vagas dos últimos 30 dias (`DIAS_RETROATIVO` em `src/util.js`): `/sim` = `/buscar 30` (coleta retroativa + análise + resumo), `/nao` só responde. A coleta nunca é retroativa sozinha: o *Janela da coleta* só marca retroativa quando o pedido chega com `retroativo = true` (a janela, em dias, vai na coluna `dias` da tabela `coletas` e chega aos nós de coleta junto com o `retroativo`) |
| 07:30 | Análise: todas as pendentes (até 300), uma chamada ao Gemini por vaga (descrições lidas em paralelo, uma fila por site); antes, a pendente cujo link já foi analisado vira `duplicada` (sem Gemini) |
| 09:30 | Resumo no Telegram (nota ≥ corte, até o limite; as excedentes ficam para o próximo; "nenhuma vaga" vem com coletadas em 24 h e pendentes) |
| ao ligar | "Bot de vagas no ar" no Telegram (n8n iniciado, workflow publicado ou atualizado) |
| a qualquer hora | Comandos no Telegram: `/vagas` (resumo agora), `/buscar` (coleta + análise + resumo; `/buscar N` (2 a 30, padrão 30) faz a coleta retroativa com a janela de N dias; `/buscar gupy`, `/buscar 30 gupy linkedin`, `/buscar carreiras` (= todas menos LinkedIn, Gupy e Remotive: os sites brasileiros + Greenhouse, Lever e Workable) limitam as fontes pelo switch *Quais fontes* depois da *Janela da coleta*; a análise e o resumo desse `/buscar` também ficam só com essas fontes (`PARAM_FONTES`/`FILTRO_FONTES` no `build.py`), e as pendentes/não enviadas das outras esperam os horários normais), `/sim` e `/nao` (resposta à pergunta do banco vazio), `/recentes [dias]` (melhores já analisadas, padrão 7), `/status`, `/perfil` (só o resumo: palavras-chave, resumo profissional, local/modelo e cargos-alvo, tirados das seções do Markdown em `perfil_mensagens.js`; `/perfil completo` = texto inteiro; `/perfil novo` = rascunho inteiro; `/perfil arquivo` volta ao `config/perfil.md`), PDF do currículo + `/usar`, `/ajuda` |

- **Comandos:** o n8n não recebe mensagens do Telegram sem webhook público, então o
  container `telegram` (`servidor/telegram_comandos.py`, só biblioteca padrão) faz long
  polling no `getUpdates` e chama o webhook interno `http://n8n:5678/webhook/bot-vagas-comando`
  com o cabeçalho `X-Bot-Vagas-Segredo` (`N8N_COMANDO_SEGREDO` do `.env`; o webhook usa *Header
  Auth* com a credencial "Comando" do `n8n_montar.py` e recusa quem não manda). O container
  roda sem root, só leitura e sem capabilities. Só aceita o `TELEGRAM_CHAT_ID`, ignora mensagens com mais de 15 min e avisa no Telegram se
  o n8n não responder; registra no log cada mensagem recebida ou ignorada (e o motivo).
  `diagnostico.sh` mostra se o token está no `.env` e no container e o log. O `/buscar` encadeia as etapas com *Execute Workflow* chamando o
  próprio workflow (gatilho "Etapa (chamada interna)"). Nenhum outro programa pode ler o
  mesmo bot por `getUpdates` (dá 409): outro projeto precisa de outro bot.

- **Currículo em PDF:** o container `telegram` baixa o PDF (até 5 MB, confere `%PDF`) e
  entrega ao webhook como `/curriculo` com `arquivo.base64` e a legenda. O Gemini
  (`prompt_curriculo.md`, PDF em `inlineData`) monta o perfil mantendo as preferências do
  perfil em uso; a resposta no Telegram mostra só o resumo (o texto inteiro com `/perfil novo`); vai para a tabela `perfis` como `rascunho` e só vale depois do `/usar`
  (`ativo`, um só). O nó *Perfil em uso* (antes do *Pegar pendentes*, passando as fontes
  adiante) lê o ativo; sem ele, vale o `PERFIL` do `config/perfil.md`.

- **Diagnóstico:** `bash servidor/diagnostico.sh` no servidor mostra o banco, testa cada
  fonte dali e lista as últimas execuções do n8n com os itens de cada nó (lê uma cópia do
  SQLite do volume com sudo).
- **Recusadas:** `bash servidor/recusadas.sh [dias] [--csv]` no servidor lista as abaixo do
  corte (`resumo.nota_minima` do config) com o motivo do modelo (coluna `analise`), as não
  lidas e a situação por fonte.
- **Sem análise dupla:** a função `link_chave` (em `build.py`, criada
  pela *Janela da coleta*, pelo *Pegar pendentes* e pelo `schema.sql`) normaliza o link;
  o *Salvar* não insere vaga com link já no banco e o *Pegar pendentes* marca `duplicada`
  a pendente com link já analisado (ou com pendente mais antiga de mesmo link). Mudou a
  função? `REINDEX INDEX vagas_link_chave_idx;` no banco.
- **Segurança do que vem dos sites** (texto de terceiros):
  - O texto da vaga vai ao Gemini entre `<<<VAGA` e `VAGA>>>`, com a regra fixa
    `REGRA_TEXTO_DA_VAGA` (`src/analise_requisicao.js`) de ignorar instruções dentro dele.
    A regra vale mesmo com `config/prompt.md` próprio.
  - O `Análise: interpretar` prefere título, empresa e local da fonte, tira links do que o
    modelo escreveu e limita o tamanho de cada campo. O `notificar_montar.js` corta de novo
    (`MAX_CAMPO`) para nenhuma vaga passar do limite do Telegram.
  - O "completar descrição" só abre link público (`linkPublico`: sem IP, nome interno ou
    usuário no endereço).
  - O HTML é cortado em `MAX_HTML` e lido sem regex com volta atrás (`semBlocos`,
    `blocosJsonLd`): uma página malformada não trava o nó.
  - O CSV do `recusadas.sh` neutraliza fórmula (texto começando com `=`, `+`, `-` ou `@`).
- **Sem e-mail:** o bot não lê e-mail (os alertas por Gmail foram removidos). Não
  reintroduzir sem o usuário pedir.
- **Buscas do LinkedIn:** o usuário manda o link da busca feita no navegador; vai para
  `linkedin_buscas`. Links de páginas que só existem logado (`/jobs/collections/...`) não servem.
- **Perfil:** `config/perfil.md` é o resumo do currículo do usuário; é o que o modelo usa
  para dar a nota.
- **Mudar a configuração do usuário** (termos, buscas, empresas, perfil...): ela fica no
  servidor, que a sessão não alcança. Entregue um comando para ele colar no `ssh vagas`
  (edição com `python3 -c` sobre `config/config.json`, ou `nano`) seguido de
  `python3 configuracao.py && bash servidor/configurar_n8n.sh`.

## Modelo de IA

- **Padrão: `gemini-flash-latest`** (plano gratuito), em `modelo_gemini` no config (padrão
  em `configuracao.py`). Não trocar o padrão sem o usuário pedir.
- **Ritmo e faturamento:** o padrão do projeto é o do plano gratuito, e o bot tem de
  funcionar sem pagar: 1 pedido a cada 6 s (`GEMINI_LOTE`/`GEMINI_INTERVALO_MS` no
  `build.py`). Com `GEMINI_FATURAMENTO=sim` no `.env` do servidor, o `n8n_montar.py` troca
  na importação por 5 pedidos por segundo (`RITMO_FATURAMENTO`). Liga/desliga:
  `bash servidor/configurar_n8n.sh --faturamento sim|nao`. Não mude o padrão do `build.py`
  por causa de uma instalação com faturamento.
- **Reserva e avisos:** com 429 ou 5xx, o pedido volta pelo laço *tentativa → HTTP →
  conferir resposta → outro modelo?* com o próximo de `modelos_reserva` (padrão
  `gemini-flash-lite-latest`; `src/gemini_erros.js` classifica: cobranca, cota, chave,
  sobrecarga, outro). Erro de serviço na análise: a vaga volta a `pendente` (sem gastar
  tentativa) e vai um aviso no Telegram (*Análise: avisar problema no Gemini*). No
  currículo, sobrecarga/cota em todos os modelos espera 2, 5 e 10 min (nó Wait) e tenta de
  novo.
- Cada vaga é uma chamada separada (regras + perfil + uma vaga), temperatura 0,1, saída
  com schema fixo e nota por último; tetos reaplicados no código
  (`src/analise_interpretar.js`). Fracionar mais não melhora a qualidade. Ordem de
  grandeza: ≈4,5 mil tokens de entrada e ≈1,5 mil de saída por vaga.

## Como aplicar mudanças no n8n

1. Edite `src/`, `prompt.md`, `configuracao.py` ou `build.py`; rode `node tests/test.js`
   (gera o workflow com `tests/config/`; e `shellcheck servidor/*.sh` se mexer nos scripts).
2. Commit e push.
3. No servidor (o usuário cola dentro do `ssh vagas`):
   - só workflow: `cd ~/bot_vagas && git pull && bash servidor/configurar_n8n.sh`
   - mudou `docker-compose.yml`: `cd ~/bot_vagas && git pull && bash servidor/instalar.sh && bash servidor/configurar_n8n.sh`

Mudança só na configuração: no servidor, edite `config/` e rode
`python3 configuracao.py && bash servidor/configurar_n8n.sh` (sem commit).

`configurar_n8n.sh` confere a configuração e gera o `workflow.json` (`build.py`; sem
`config/config.json`, copia o `exemplo/` e para), não pergunta nada se as credenciais já existem (Postgres vem do `.env`,
chat id do `.env`), importa o workflow com ID fixo (`BotVagasWorkflow`) e credenciais com
IDs fixos (`servidor/n8n_montar.py`), despublica outro workflow "Bot de vagas" com ID
diferente (avisa para apagar no n8n), publica e reinicia o n8n; o aviso "no ar" chega no
Telegram ~30 s depois. Para trocar chave do Gemini ou token do Telegram: `--trocar`. Gemini mais rápido com
faturamento: `--faturamento sim` (volta com `--faturamento nao`; fica no `.env`).
Importar sempre despublica: por isso o script publica de novo.

Não dá para acessar o servidor nem o LinkedIn a partir da sessão do Claude: entregue
comandos para o usuário rodar e peça o resultado.

## Testes

Os nós Code rodam no task runner do n8n, num contexto `vm` **sem `URL`, `URLSearchParams`,
`fetch`** e outros globais do Node (só `Buffer`, timers, `btoa`/`atob`, `TextEncoder`/`TextDecoder`).
Um `new URL()` fez a coleta do LinkedIn voltar vazia por dias sem erro visível. O
`tests/test.js` roda cada nó num contexto igual; falhas de coleta viram item `aviso`
(o *Salvar* ignora, o `diagnostico.sh` mostra).

`node tests/test.js` (e `shellcheck servidor/*.sh` se mexer nos scripts) antes de todo commit.
Também roda `tests/test_telegram_comandos.py`. Testes não acessam a rede.

## Nome de branch e commits

Branch `<tipo>/<descricao-curta>` (com `<ISSUE>-` antes da descrição quando houver issue;
`feature`, `fix`, `docs`, `chore`, `refactor`, `test`; descrição em português, minúsculas,
sem acento, com hífen) que diga o que está sendo feito, nascendo de `main`. Ex.:
`feature/buscar-por-fonte-e-sites-brasileiros`, `fix/endereco-api-gupy`.
**Nunca use o nome genérico que a sessão sugerir** (ex.: `claude/trusting-cannon-8dy0jp`):
crie o branch com nome descritivo antes do primeiro push.

## Comandos para o usuário rodar

O guia supõe Windows PowerShell 5.1 no computador do usuário: uma única linha que para no
primeiro erro (`cmd1; if ($LASTEXITCODE -eq 0) { cmd2 }` — o PowerShell 5.1 não aceita
`&&`). Comandos do servidor (bash) vão para colar dentro do `ssh vagas`, em uma linha com `&&`.
