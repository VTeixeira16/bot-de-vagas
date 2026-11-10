-- Banco do bot de vagas (PostgreSQL 12+). Rode uma vez no banco que o n8n vai usar.
CREATE TABLE IF NOT EXISTS vagas (
  id            bigserial PRIMARY KEY,
  fonte         text        NOT NULL,              -- linkedin | gupy | remotive | indeed | ...
  id_externo    text        NOT NULL,              -- ID da vaga na fonte (ou hash, nos alertas por e-mail)
  link          text        NOT NULL,
  titulo        text,
  empresa       text,
  local         text,
  texto         text,                              -- descrição usada na análise
  publicado_em  timestamptz,
  status        text        NOT NULL DEFAULT 'pendente', -- pendente | analisada | duplicada | erro_fetch | erro_llm
  tentativas    int         NOT NULL DEFAULT 0,
  score         int,
  analise       jsonb,                             -- saída completa do LLM
  notificada    boolean     NOT NULL DEFAULT false,
  decisao       text,                              -- livre: candidatei | descartei | entrevista ...
  coletado_em   timestamptz NOT NULL DEFAULT now(),
  analisado_em  timestamptz,
  UNIQUE (fonte, id_externo)
);

CREATE INDEX IF NOT EXISTS vagas_pendentes_idx  ON vagas (coletado_em) WHERE status IN ('pendente', 'erro_llm');
CREATE INDEX IF NOT EXISTS vagas_notificar_idx  ON vagas (id) WHERE notificada = false;

-- Chave do link (a mesma do build.py): vaga com link já no banco não entra de novo, e a
-- pendente com link já analisado vira 'duplicada' sem passar pelo Gemini.
CREATE OR REPLACE FUNCTION link_chave(l text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT regexp_replace(regexp_replace(lower(split_part(split_part(l, '#', 1), '?', 1)),
           '^https?://(www[.])?', ''), '/+$', '')
         || COALESCE('?' || lower((regexp_match(l, '[?&]((?:gh_jid|jobid|job_id|id|vaga)=[^&#]+)', 'i'))[1]), '')
$f$;
CREATE INDEX IF NOT EXISTS vagas_link_chave_idx ON vagas (link_chave(link));

-- Uma linha por coleta; retroativo = buscou os últimos 30 dias (só quando pedido: /sim à
-- pergunta do banco vazio ou /buscar 30). O nó "Janela da coleta" também cria esta tabela
-- se ela faltar.
CREATE TABLE IF NOT EXISTS coletas (
  id          bigserial   PRIMARY KEY,
  iniciada_em timestamptz NOT NULL DEFAULT now(),
  retroativo  boolean     NOT NULL
);

-- Perfis montados a partir do PDF do currículo mandado ao bot no Telegram. O 'ativo' (só
-- um, confirmado com /usar) vale no lugar do config/perfil.md; /perfil arquivo volta ao
-- arquivo. Os nós do n8n também criam esta tabela se ela faltar.
CREATE TABLE IF NOT EXISTS perfis (
  id        bigserial   PRIMARY KEY,
  texto     text        NOT NULL,
  origem    text,                                  -- nome do arquivo mandado
  status    text        NOT NULL DEFAULT 'rascunho', -- rascunho | ativo | antigo | descartado
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Consultas úteis
-- Melhores da semana:
--   SELECT score, titulo, empresa, local, link FROM vagas
--   WHERE analisado_em > now() - interval '7 days' ORDER BY score DESC LIMIT 30;
-- Recusadas (abaixo do corte) com o motivo: bash servidor/recusadas.sh [dias] [--csv]
-- Registrar decisão:
--   UPDATE vagas SET decisao = 'candidatei' WHERE link = '...';
