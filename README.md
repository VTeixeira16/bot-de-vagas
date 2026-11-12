# Bot de vagas

Coleta vagas de várias fontes, dá a cada uma uma nota de 0 a 100 com o Gemini, a partir do
**seu** perfil, e manda no Telegram, uma vez por dia, as que combinam com você. Roda num
n8n com PostgreSQL, em Docker, num servidor seu.

Tudo o que é seu (perfil, termos de busca, sites, empresas, nota de corte, horários) fica
em dois arquivos de configuração, fora do git. Você não precisa mexer no código.

Nenhuma etapa faz login em site de vagas nem age na sua conta. A candidatura continua
sendo sua: o resumo traz o link, a nota, o que combina e o que falta.

## Como funciona

Os horários abaixo são os padrões; todos podem ser mudados na configuração.

```
07:00 / 19:00  Coletar ──┬─ LinkedIn ........ as suas buscas (links), pela lista pública
                         │                    de vagas, sem login
                         ├─ Gupy ............ portal público de vagas
                         ├─ Remotive ........ vagas remotas internacionais
                         ├─ Sites BR ........ InfoJobs, Catho, Vagas.com, Remotar e Trampos
                         └─ Carreiras ....... páginas de vagas das empresas que você
                                              escolher (Greenhouse, Lever, Workable)
                              ↓
                         banco (vaga repetida não entra nem é analisada de novo);
                         com o banco vazio, o bot pergunta se busca os últimos 30 dias
                              ↓
07:30          Analisar ── lê a descrição completa de cada vaga nova
                           → Gemini dá a nota comparando com o seu perfil
                              ↓
09:30          Resumo ──── Telegram: vagas com nota ≥ nota_minima (70), maior nota primeiro

a qualquer     Comandos ── você manda ao bot no Telegram (lista em "Comandos do Telegram")
hora
```

## Do que você precisa

- Um **servidor Linux** (VPS) com Ubuntu 22.04/24.04 ou Debian 12 e acesso `root` por SSH.
- Uma **chave do Gemini** (Google AI Studio). O plano gratuito dá conta do uso normal.
- Um **bot do Telegram** e o seu chat id.
- Cerca de 1 hora na primeira vez.

## Instalação

### 1. Prepare o servidor

Siga o [guia de instalação no servidor](docs/servidor.md) até o passo 5. Ele cobre o
acesso por SSH, a segurança do servidor, o Docker, o banco e o n8n. Os passos abaixo
(chaves, configuração e ligar o bot) correspondem ao passo 6 do guia.

### 2. Crie as chaves

- **Gemini**: em [aistudio.google.com](https://aistudio.google.com) → *Get API key* →
  *Create API key*. No plano gratuito o Google pode usar os textos enviados para melhorar
  os produtos dele; se isso incomodar, ative o faturamento no projeto do Google (o custo
  aqui é de centavos por mês).
- **Telegram**: fale com o [@BotFather](https://t.me/BotFather) → `/newbot` → escolha um
  nome → guarde o **token**. Depois mande qualquer mensagem para o seu bot e abra
  `https://api.telegram.org/bot<TOKEN>/getUpdates` no navegador: o número em
  `"chat":{"id": ...}` é o seu **chat id**.

### 3. Escreva a sua configuração

No servidor, na pasta do bot, copie o exemplo e troque pelos seus dados:

```bash
cp -r exemplo config
nano config/perfil.md
nano config/config.json
```

(No `nano`: Ctrl+O e Enter salvam, Ctrl+X sai.) O que vai em cada arquivo está em
[Configuração](#configuração). Depois confira:

```bash
python3 configuracao.py
```

Ele diz, em português, o que estiver errado (vírgula faltando, campo com nome trocado,
horário inválido...) e mostra a configuração final, já com os padrões do que você deixou
de fora.

### 4. Ligue o bot

```bash
bash servidor/configurar_n8n.sh
```

Ele pede a chave do Gemini, o token e o chat id do Telegram (o que você cola não aparece
na tela), cria as credenciais no n8n, gera o workflow a partir da sua configuração,
importa e publica. Rodar de novo atualiza sem duplicar e mantém as credenciais.

### 5. Teste

Logo depois do `configurar_n8n.sh` chega no Telegram o "Bot de vagas no ar". Com o banco
vazio, ele pergunta se você quer as vagas dos últimos 30 dias: `/sim` busca agora, analisa
e manda o resumo (demora mais: a análise leva uns 6 s por vaga); `/nao` segue só com as
vagas novas, a partir da próxima coleta. Depois, `/buscar` coleta, analisa e manda o resumo
na hora, e `/status` mostra como está o banco.

## Configuração

Fica em `config/`, fora do git: atualizar o bot (`git pull`) nunca mexe nela, e o backup
(`servidor/backup.sh`) guarda uma cópia. São dois arquivos.

### `config/perfil.md`: quem você é

O resumo do seu currículo, em texto livre. Vai inteiro para o Gemini junto com cada vaga,
então é o que mais muda a nota. Escreva:

- o que você fez (cargos, empresas, resultados com números, se tiver);
- o que você sabe (tecnologias, ferramentas, idiomas);
- o que você procura (cargo, senioridade, cidade, remoto/híbrido/presencial);
- o que você **não** quer (eliminatórias: "não aceito presencial fora de SP", "não quero
  vaga de vendas").

O `exemplo/perfil.md` mostra o formato. Em vez de escrever à mão, você pode mandar o PDF
do currículo ao bot (veja [Currículo em PDF](#currículo-em-pdf)).

### `config/config.json`: o que buscar e como avaliar

Campos que faltarem usam o padrão, então você pode começar só com o que quer mudar.
Campos que começam com `_` são só comentários.

| Campo | O que faz |
|---|---|
| `nome` | Aparece no nome do workflow no n8n ("Bot de vagas — nome"). Pode ficar `""` |
| `modelo_gemini` | Modelo que dá as notas (padrão `gemini-flash-latest`, que acompanha o Flash mais recente) |
| `modelos_reserva` | Tentados na ordem quando o modelo principal está sem cota ou sobrecarregado (padrão `["gemini-flash-lite-latest"]`). No plano gratuito, cada modelo tem a própria cota |
| `horarios` | `coleta` (lista de `"HH:MM"`), `analise` e `resumo`, no horário de Brasília |
| `resumo` | `nota_minima` (0–100) para a vaga aparecer e `max_vagas` por resumo; as que sobram vão no próximo |
| `fontes` | `true`/`false` para cada fonte. Desligada, ela some da coleta, do `/buscar` e do `/ajuda` |
| `linkedin_buscas` | Links de buscas feitas no LinkedIn ([veja abaixo](#linkedin)) |
| `termos_de_busca` | `cargos`: pesquisados na Gupy e nos sites brasileiros. `assuntos`: só na Gupy (trazem vagas de qualquer cargo daquele assunto). `remotive_categoria`: `software-dev`, `data`, `devops`, `product`... |
| `paginas_de_carreira` | Empresas cujas páginas de vagas o bot acompanha ([veja abaixo](#páginas-de-carreira)) |
| `filtro_titulo` | Quais títulos vão para o Gemini, em todas as fontes (a busca do LinkedIn e da Gupy é aproximada e traz muito título fora do pedido) |
| `descartar_titulos` | Títulos descartados em todas as fontes: `com` (em qualquer lugar do título) e `comecando_com` |
| `locais_de_interesse` | Só para as páginas de carreira: `palavras` do local e códigos de `paises` (`"BR"`) aceitos |
| `avaliacao` | Regras da nota ([veja abaixo](#avaliação)) |

#### Como os termos são comparados

Vale para `filtro_titulo`, `descartar_titulos` e `locais_de_interesse`:

- sem acento e sem maiúsculas;
- palavra inteira: `"ti"` não pega "time";
- `*` no fim vale qualquer palavra que comece assim: `"coordena*"` pega coordenador,
  coordenadora, coordenação;
- termos com mais de uma palavra valem juntos: `"recursos humanos"`.

O `filtro_titulo` deixa passar o título que tiver um termo de `basta_ter`, **ou** um termo
de cada grupo de `ou_ter_um_de_cada_grupo` (ex.: um cargo de liderança e uma área técnica),
e nenhum de `recusar`. Tudo vazio = passa tudo. Cada vaga que passa é uma consulta ao
Gemini, então um filtro bom economiza cota.

#### LinkedIn

Faça a busca no LinkedIn como faria normalmente (palavras-chave, local, filtros), copie o
endereço da barra do navegador e cole em `linkedin_buscas`. Pode pôr quantas quiser.

- O bot usa a versão pública da lista de vagas (a que aparece sem login), nunca a sua
  conta.
- Sem local no link, busca no Brasil. Sem filtro de data, pega as das últimas 24 h.
- Links de páginas que só existem logado ("Vagas recomendadas para você",
  `/jobs/collections/...`) não funcionam.

#### Páginas de carreira

Para acompanhar uma empresa, descubra em qual plataforma fica a página de vagas dela e
pegue o identificador no endereço:

| Plataforma | Endereço da página | Identificador |
|---|---|---|
| `greenhouse` | `job-boards.greenhouse.io/<id>` | `<id>` |
| `lever` | `jobs.lever.co/<id>` | `<id>` |
| `workable` | `apply.workable.com/<id>` | `<id>` |

E adicione em `paginas_de_carreira`, como `"identificador": "Nome da empresa"` (com `""`
o bot usa o nome que a página informar). Só entram vagas dos `locais_de_interesse` que
passem no `filtro_titulo`.

#### Avaliação

O Gemini dá a nota seguindo uma rubrica; estes campos de `avaliacao` ajustam a rubrica
ao que você procura:

- `regiao`: onde você aceita trabalhar.
- `areas`: as categorias de vaga que interessam (`nome` e `descricao`). Vaga fora delas
  fica com nota máxima 45.
- `pontos_area`: quanto vale cada tipo de vaga no bloco "Cargo e área" (0 a 40).
- `pontos_senioridade`: quanto vale cada nível de senioridade.
- `senioridades_com_teto`: níveis que ficam com nota máxima 30 (`junior_ou_abaixo`,
  `pleno`, `senior`, `especialista_staff`, `lideranca_tecnica`, `coordenacao`, `gerencia`,
  `head_diretoria`).

Para mudar a rubrica inteira, copie `prompt.md` para `config/prompt.md` e edite lá: o de
`config/` vale no lugar do original.

### Aplicar uma mudança

Depois de editar qualquer arquivo de `config/`:

```bash
python3 configuracao.py
bash servidor/configurar_n8n.sh
```

O primeiro confere; o segundo gera o workflow de novo e importa, mantendo as credenciais.

## Comandos do Telegram

| Comando | O que faz |
|---|---|
| `/vagas` | Resumo agora (vagas analisadas que ainda não foram enviadas) |
| `/buscar` | Coleta + análise + resumo agora |
| `/buscar 30` | O mesmo, com as vagas dos últimos 30 dias (vale outro prazo: `/buscar 3` = últimos 3 dias) |
| `/sim`, `/nao` | Resposta à pergunta do bot com o banco vazio: busca (ou não) as vagas dos últimos 30 dias |
| `/buscar gupy catho` | Só algumas fontes (dá para juntar: `/buscar 30 gupy`). `/buscar carreiras` roda os sites brasileiros e as páginas de carreira |
| `/recentes` | Repete as melhores dos últimos 7 dias (`/recentes 3` = 3 dias) |
| `/status` | Situação do bot e do banco |
| `/perfil` | Resumo do perfil usado nas notas (`/perfil completo` = texto inteiro) |
| PDF do currículo | Monta um perfil novo para você conferir ([veja abaixo](#currículo-em-pdf)) |
| `/usar` | Passa a usar o perfil montado do PDF |
| `/ajuda` | Lista de comandos |

Os comandos servem, por exemplo, quando o servidor ficou desligado na hora da coleta ou
do resumo. O bot só responde ao seu chat e ignora comandos mandados há mais de 15
minutos. Nada fica exposto na internet: um container pequeno pergunta ao Telegram por
mensagens novas e entrega ao n8n pela rede interna.

Quando o bot liga (servidor reiniciado ou workflow publicado), ele avisa no Telegram.

## Currículo em PDF

Mande o PDF do currículo ao bot (clipe → Arquivo; até 5 MB) e o Gemini monta um perfil no
mesmo formato do `perfil.md`:

- Experiência, competências, formação e idiomas vêm do currículo.
- Preferências (cargos-alvo, senioridade, local, eliminatórias) e o que não costuma estar
  num currículo (projetos pessoais) vêm do perfil em uso.
- Na **legenda** do arquivo dá para pedir ajustes, como "agora só quero vagas remotas";
  ela vale mais que o resto.

O bot responde com o essencial do perfil e com o que vale conferir; `/perfil novo` mostra
o texto inteiro. Ele **só passa a valer** quando você manda `/usar`, a partir da próxima
análise (as vagas já analisadas mantêm a nota). Outro PDF antes do `/usar` substitui o
rascunho. `/perfil arquivo` volta a usar o `config/perfil.md`. Enquanto um perfil do PDF
estiver valendo, mudar o `config/perfil.md` não tem efeito (o `configurar_n8n.sh` avisa).

O PDF vai para o Gemini nas mesmas condições das vagas. O perfil gerado não leva e-mail,
telefone, endereço nem documentos. PDF escaneado como imagem pode não funcionar: salve o
currículo como PDF direto do editor de texto. Para mudar as instruções, copie o
`prompt_curriculo.md` para `config/prompt_curriculo.md` e edite lá.

## Primeira semana: calibrar

Abra as vagas com nota entre 60 e 85 e veja se você concorda. Se não concordar, o ajuste
mais eficaz é no `config/perfil.md` (o que você fez e o que não quer) e na `avaliacao` do
`config/config.json`. Para ver por que uma vaga ficou abaixo do corte:

```bash
bash servidor/recusadas.sh 7
```

Lista as dos últimos 7 dias com a nota e o motivo (o que atende, o que falta). Com
`--csv`, grava uma planilha em `~/relatorios`.

Para registrar o que você fez com cada vaga (e depois medir se a nota prevê as suas
escolhas), no banco:

```sql
UPDATE vagas SET decisao = 'candidatei' WHERE link = '...';
```

## Gemini: cota e faturamento

- **Plano gratuito (padrão)**: o bot faz 1 pedido a cada 6 s, que cabe na cota. Se a cota
  acabar, o pedido vai para o próximo modelo de `modelos_reserva`. Se todos recusarem,
  chega um aviso no Telegram e as vagas voltam para a fila da próxima análise, sem perder
  a vez.
- **Com faturamento**: `bash servidor/configurar_n8n.sh --faturamento sim` deixa a análise
  bem mais rápida (5 pedidos por segundo). `--faturamento nao` volta ao padrão.
- **Trocar a chave**: `bash servidor/configurar_n8n.sh --trocar` (Enter em branco mantém a
  credencial atual). Para usar sem pagar, a chave precisa ser de um projeto do Google sem
  faturamento.

Erro de chave (inválida) ou de cobrança (créditos acabaram) também chega como aviso no
Telegram, dizendo o que fazer.

## Limites e cuidados

- **LinkedIn**: só páginas públicas, com pausa entre requisições, 2 vezes por dia, sem a
  sua conta. O pior caso é o LinkedIn bloquear o IP do servidor por um tempo. Vaga cuja
  página não abre aparece no resumo em "Não consegui ler", com o link.
- **Gupy e sites brasileiros**: usam os mesmos endereços que os próprios sites usam, que
  não são APIs documentadas e podem mudar sem aviso. Se uma fonte parar de responder, as
  outras seguem; `bash servidor/diagnostico.sh` testa cada uma.
- **Páginas de carreira**: APIs públicas do Greenhouse, do Lever e do Workable. Uma
  empresa que troque de plataforma passa a dar erro no `diagnostico.sh`, sem afetar as
  outras.
- **Mesma vaga em duas fontes**: o bot reconhece pelo link; links diferentes para a mesma
  vaga (LinkedIn e página da empresa) são juntados no resumo pelo título + empresa.
- **Remotive**: publica as vagas com 24 h de atraso e pede que a fonte seja citada (o
  resumo mostra "via Remotive").
- **Indeed e Glassdoor** não estão entre as fontes: bloqueiam robôs.
- **Candidatura automática** não existe, de propósito.

## Outro n8n (sem o servidor do guia)

Se você já tem um n8n com PostgreSQL:

1. Rode o `schema.sql` no banco.
2. Gere o workflow com `python3 build.py` e importe o `workflow.json`
   (*Workflows → Import from file*).
3. Crie as credenciais e selecione nos nós:
   - **Postgres** → os nós *Salvar…*, *Pegar pendentes*, *Marcar…* e *Vagas a notificar*.
   - **Header Auth** com nome `x-goog-api-key` e valor = chave do Gemini → nó
     *Análise: pontuar (Gemini)*.
   - **Telegram API** com o token → nó *Telegram: enviar*. Troque `SEU_CHAT_ID` pelo seu
     chat id.
4. Rode à mão, na ordem, *Coletar* → *Analisar* → *Resumo* e confira o Telegram.
5. Publique o workflow (*Publish*).

Os comandos do Telegram dependem do container `telegram` do `docker-compose.yml`.

## Arquivos

| Arquivo | Para quê |
|---|---|
| `config/` | **Sua configuração** (`config.json` e `perfil.md`). Fora do git |
| `exemplo/` | Configuração fictícia para começar: `cp -r exemplo config` |
| `configuracao.py` | Confere a configuração e completa com os padrões |
| `prompt.md` | Rubrica da nota (os `{{campos}}` vêm de `avaliacao`) |
| `prompt_curriculo.md` | Instruções para transformar o PDF do currículo em perfil |
| `docs/servidor.md` | Passo a passo da instalação no servidor |
| `servidor/` | Scripts de preparação, instalação, configuração do n8n, backup e diagnóstico |
| `docker-compose.yml` | n8n + PostgreSQL + leitor de comandos do Telegram |
| `schema.sql` | Tabelas do banco |
| `src/`, `build.py` | Código dos nós e gerador do workflow |
| `tests/` | Testes: `node tests/test.js` |

## Licença

MIT (veja `LICENSE`): pode usar, mudar e distribuir, mantendo o aviso de copyright.
