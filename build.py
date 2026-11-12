#!/usr/bin/env python3
"""Gera workflow.json (importável no n8n) a partir de src/*.js, prompt.md e da sua
configuração (config/config.json e config/perfil.md, fora do git; ver configuracao.py).

Uso: python3 build.py [--config PASTA] [--saida ARQUIVO]
O servidor/configurar_n8n.sh roda isto antes de importar; o workflow.json não vai para o git.
"""
import argparse
import json
import re
import sys
import urllib.parse
import uuid
from pathlib import Path

import configuracao

RAIZ = Path(__file__).parent
WORKFLOW_ID = "BotVagasWorkflow"  # o mesmo do servidor/n8n_montar.py
SRC = RAIZ / "src"

_args = argparse.ArgumentParser(description=__doc__.splitlines()[0])
_args.add_argument("--config", help="pasta com config.json e perfil.md (padrão: config/)")
_args.add_argument("--saida", default=str(RAIZ / "workflow.json"), help="arquivo gerado (padrão: workflow.json)")
ARGS = _args.parse_args()
try:
    CFG, PERFIL, PROMPT, AVISOS = configuracao.carregar(ARGS.config)
except configuracao.ErroConfig as e:
    sys.exit(f"ERRO na configuração:\n{e}")
for _a in AVISOS:
    print(f"AVISO: {_a}")

# A configuração vai para dentro de cada nó Code como a constante CONFIG (o n8n não lê arquivos)
UTIL = (f"const CONFIG = {json.dumps(configuracao.para_js(CFG), ensure_ascii=False)};\n"
        + (SRC / "util.js").read_text(encoding="utf-8"))
HORA = CFG["horarios"]
# Janela da coleta retroativa (src/util.js), para os textos montados aqui
DIAS_RETRO = int(re.search(r"const DIAS_RETROATIVO = (\d+);", UTIL).group(1))
ATIVAS = [f for f in configuracao.FONTES if CFG["fontes"][f]]


def js(arquivo, chamada, extra=""):
    corpo = (SRC / arquivo).read_text(encoding="utf-8")
    return f"{UTIL}\n{extra}\n{corpo}\n{chamada}\n"


def cron(*horas):
    """Horários HH:MM -> expressões cron (uma por minuto diferente: 07:00 e 19:00 = '0 7,19 * * *')."""
    por_minuto = {}
    for h in horas:
        hh, mm = h.split(":")
        por_minuto.setdefault(int(mm), []).append(str(int(hh)))
    return [f"{m} {','.join(hs)} * * *" for m, hs in sorted(por_minuto.items())]


def fonte_js(arquivo):
    """Corpo de um arquivo de src/ para juntar a outro nó (sem UTIL, que já vai no início)."""
    return (SRC / arquivo).read_text(encoding="utf-8")


def nid(nome):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "bot-vagas/" + nome))


nodes, conexoes = [], {}


def node(nome, tipo, versao, pos, params, **extra):
    nodes.append({"id": nid(nome), "name": nome, "type": tipo, "typeVersion": versao,
                  "position": list(pos), "parameters": params, **extra})
    return nome


def liga(origem, destino, saida=0):
    lst = conexoes.setdefault(origem, {"main": []})["main"]
    while len(lst) <= saida:
        lst.append([])
    lst[saida].append({"node": destino, "type": "main", "index": 0})


def code(nome, pos, codigo, **extra):
    return node(nome, "n8n-nodes-base.code", 2, pos,
                {"mode": "runOnceForAllItems", "jsCode": codigo}, **extra)


def agenda(nome, pos, horas):
    return node(nome, "n8n-nodes-base.scheduleTrigger", 1.2, pos,
                {"rule": {"interval": [{"field": "cronExpression", "expression": c} for c in cron(*horas)]}})


def sql(nome, pos, query, param=None, **extra):
    opts = {"queryReplacement": param} if param else {}
    return node(nome, "n8n-nodes-base.postgres", 2.5, pos,
                {"operation": "executeQuery", "query": query, "options": opts}, **extra)


# Ritmo das chamadas ao Gemini: GEMINI_LOTE pedidos de uma vez, um lote a cada
# GEMINI_INTERVALO_MS. Padrão do plano gratuito: 1 a cada 6 s (~10 por minuto). Com
# faturamento ativo, o servidor/n8n_montar.py troca pelo ritmo rápido na importação
# (GEMINI_FATURAMENTO=sim no .env; bash servidor/configurar_n8n.sh --faturamento sim).
GEMINI_LOTE = 1
GEMINI_INTERVALO_MS = 6000


def gemini(nome, pos, timeout=90000):
    return node(nome, "n8n-nodes-base.httpRequest", 4.2, pos, {
        "method": "POST",
        "url": "=https://generativelanguage.googleapis.com/v1beta/models/{{ $json.modelo }}:generateContent",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.llm_body) }}",
        "options": {"batching": {"batch": {"batchSize": GEMINI_LOTE, "batchInterval": GEMINI_INTERVALO_MS}}, "timeout": timeout},
    }, onError="continueRegularOutput", retryOnFail=True, maxTries=3, waitBetweenTries=5000)


GEMINI_ERROS = (SRC / "gemini_erros.js").read_text(encoding="utf-8")


def se(nome, pos, campo):
    """If: saída 0 quando $json.<campo> é verdadeiro, saída 1 quando não."""
    return node(nome, "n8n-nodes-base.if", 2.2, pos, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": nid(f"cond-{nome}"), "leftValue": f"={{{{ $json.{campo} }}}}", "rightValue": "",
                            "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
            "combinator": "and",
        },
        "looseTypeValidation": True, "options": {},
    })


def gemini_com_reserva(prefixo, nome_http, pos, timeout=90000):
    """Pedido ao Gemini que, com cota estourada (429) ou sobrecarga (5xx), tenta o próximo de
    modelos_reserva: tentativa -> HTTP -> conferir resposta -> refazer? (sim: volta à
    tentativa). Devolve (primeiro nó, nó "refazer?"; a saída 1 dele é a que segue)."""
    x, y = pos
    t = code(f"{prefixo}: tentativa", (x, y), js("gemini_tentativa.js", "return main($input.all());", GEMINI_ERROS))
    h = gemini(nome_http, (x + 260, y), timeout)
    c = code(f"{prefixo}: conferir resposta", (x + 520, y),
             js("gemini_conferir.js", f"return main($input.all(), $('{prefixo}: tentativa').all());", GEMINI_ERROS))
    s = se(f"{prefixo}: outro modelo?", (x + 780, y), "refazer")
    liga(t, h); liga(h, c); liga(c, s); liga(s, t, 0)
    return t, s


def telegram(nome, pos):
    # chatId trocado pelo do .env no servidor/n8n_montar.py
    return node(nome, "n8n-nodes-base.telegram", 1.2, pos, {
        "chatId": "SEU_CHAT_ID",
        "text": "={{ $json.texto }}",
        "additionalFields": {"appendAttribution": False, "parse_mode": "HTML", "disable_web_page_preview": True},
    })


def escolha(nome, pos, campo, valores):
    """Switch: uma saída por valor de $json.<campo>, na ordem de `valores`."""
    regras = [{
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
            "conditions": [{"id": nid(f"{nome}-{v}"), "leftValue": f"={{{{ $json.{campo} }}}}", "rightValue": v,
                            "operator": {"type": "string", "operation": "equals"}}],
            "combinator": "and",
        },
        "renameOutput": True, "outputKey": v,
    } for v in valores]
    return node(nome, "n8n-nodes-base.switch", 3.2, pos, {"rules": {"values": regras}, "options": {}})


def etapa(nome, pos, qual):
    """Roda uma etapa (coleta, análise, resumo) neste mesmo workflow e espera terminar."""
    c = code(f"Etapa: {qual}", pos, "const cmd = $('Comando: interpretar').first().json;\n"
             f"return [{{ json: {{ etapa: '{qual}', retroativo: cmd.retroativo === true, "
             f"dias: cmd.dias || {DIAS_RETRO}, "
             "fontes: (cmd.fontes || []).join(' ') || 'todas' } }];")
    e = node(nome, "n8n-nodes-base.executeWorkflow", 1.2, (pos[0] + 260, pos[1]), {
        "source": "database",
        "workflowId": {"__rl": True, "value": WORKFLOW_ID, "mode": "id"},
        "workflowInputs": {"mappingMode": "defineBelow", "value": {}, "matchingColumns": [], "schema": [],
                           "attemptToConvertTypes": False, "convertFieldsToString": True},
        "mode": "once",
        "options": {"waitForSubWorkflow": True},
    }, alwaysOutputData=True, onError="continueRegularOutput")
    liga(c, e)
    return c, e


def get(nome, pos, url, intervalo=1500):
    return node(nome, "n8n-nodes-base.httpRequest", 4.2, pos, {
        "url": url,
        "options": {"batching": {"batch": {"batchSize": 1, "batchInterval": intervalo}}, "timeout": 30000},
    }, onError="continueRegularOutput")


INSERT = """INSERT INTO vagas (fonte, id_externo, link, titulo, empresa, local, texto, publicado_em)
SELECT r.fonte, r.id_externo, r.link, r.titulo, r.empresa, r.local, r.texto, r.publicado_em
FROM jsonb_to_record($1::jsonb) AS r(fonte text, id_externo text, link text, titulo text,
     empresa text, local text, texto text, publicado_em timestamptz)
WHERE r.fonte IS NOT NULL AND r.id_externo IS NOT NULL   -- itens de aviso não são vagas
  -- mesmo link já no banco (por outra fonte ou outro ID): não entra, não é analisada de novo
  AND NOT EXISTS (SELECT 1 FROM vagas v WHERE link_chave(v.link) = link_chave(r.link))
ON CONFLICT (fonte, id_externo) DO NOTHING;"""

# Chave do link para não analisar a mesma vaga duas vezes: sem http(s), www, #, barra no fim
# e parâmetros (de rastreio), mas guardando o ID da vaga quando ele vem num parâmetro
# (gh_jid, jobId, id...). Criada pela "Janela da coleta" e pelo "Pegar pendentes" (e pelo
# schema.sql), para valer também em bancos já existentes. Mudou a regra? Rode
# REINDEX INDEX vagas_link_chave_idx; depois.
LINK_CHAVE = """CREATE OR REPLACE FUNCTION link_chave(l text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT regexp_replace(regexp_replace(lower(split_part(split_part(l, '#', 1), '?', 1)),
           '^https?://(www[.])?', ''), '/+$', '')
         || COALESCE('?' || lower((regexp_match(l, '[?&]((?:gh_jid|jobid|job_id|id|vaga)=[^&#]+)', 'i'))[1]), '')
$f$;
CREATE INDEX IF NOT EXISTS vagas_link_chave_idx ON vagas (link_chave(link));
"""
# Perfis montados a partir do PDF do currículo mandado no Telegram. Status: rascunho (esperando
# o /usar), ativo (o usado nas notas; só um), antigo e descartado. Sem nenhum ativo, vale o
# config/perfil.md. Os nós que usam a tabela criam se faltar (bancos já existentes).
PERFIS = """CREATE TABLE IF NOT EXISTS perfis (
  id        bigserial   PRIMARY KEY,
  texto     text        NOT NULL,
  origem    text,
  status    text        NOT NULL DEFAULT 'rascunho',
  criado_em timestamptz NOT NULL DEFAULT now()
);
"""
PERFIL_EM_USO = PERFIS + """SELECT
  (SELECT texto FROM perfis WHERE status = 'ativo' ORDER BY id DESC LIMIT 1) AS perfil,
  (SELECT criado_em FROM perfis WHERE status = 'ativo' ORDER BY id DESC LIMIT 1) AS perfil_em,
  (SELECT criado_em FROM perfis WHERE status = 'rascunho' ORDER BY id DESC LIMIT 1) AS rascunho_em"""
PARAM_JSON = "={{ [ JSON.stringify($json) ] }}"
# Fontes pedidas no /buscar (texto 'todas' ou nomes separados por espaço; no /vagas vem como
# lista vazia; no horário agendado não vem): a análise e o resumo do /buscar linkedin ficam
# só com o LinkedIn, e as outras pendentes esperam o horário normal.
PARAM_FONTES = "={{ [ [].concat($json.fontes || []).join(' ') || 'todas' ] }}"
FILTRO_FONTES = "($1::text = 'todas' OR {col} = ANY(string_to_array($1::text, ' ')))"

# ---------------------------------------------------------------- 1. Coleta
NOME_COLETA = f"Coletar ({configuracao.lista_humana(HORA['coleta'], 'e')})"
t1 = agenda(NOME_COLETA, (0, 300), HORA["coleta"])

# Diz se esta coleta é a retroativa (/buscar N, de 2 a DIAS_RETROATIVO dias) e com que
# janela: só quando pedida pelo /sim (resposta à pergunta do banco vazio) ou pelo /buscar
# com número (chega com retroativo = true e dias = N); nunca sozinha. Cria a tabela (e a
# coluna dias, em bancos antigos) se faltar.
j1 = sql("Janela da coleta", (200, 300), f"""CREATE TABLE IF NOT EXISTS coletas (
  id          bigserial   PRIMARY KEY,
  iniciada_em timestamptz NOT NULL DEFAULT now(),
  retroativo  boolean     NOT NULL,
  dias        int         NOT NULL DEFAULT {DIAS_RETRO}
);
ALTER TABLE coletas ADD COLUMN IF NOT EXISTS dias int NOT NULL DEFAULT {DIAS_RETRO};
""" + LINK_CHAVE + f"""INSERT INTO coletas (retroativo, dias)
SELECT $1::boolean, $2::int
RETURNING retroativo, dias, $3::text AS fontes;""",
       "={{ [ $json.retroativo === true, $json.dias || " + str(DIAS_RETRO) + ", $json.fontes || 'todas' ] }}")
liga(t1, j1)

# Fontes desta coleta: todas as ligadas no config.json (fontes) no horário; o /buscar gupy
# (etc.) escolhe só algumas. "fontes" chega como 'todas' ou nomes separados por espaço.
# Sites brasileiros lidos pelo src/sites_buscar.js: fonte -> nome do nó
SITES_BR = {"infojobs": "InfoJobs", "catho": "Catho", "vagas.com": "Vagas.com", "remotar": "Remotar", "trampos": "Trampos"}
# Páginas de carreira das empresas (src/carreiras_buscar.js): fonte -> nome do nó
CARREIRAS = {"greenhouse": "Greenhouse", "lever": "Lever", "workable": "Workable"}
FONTES = ["linkedin", "gupy", "remotive", *SITES_BR, *CARREIRAS]
assert FONTES == configuracao.FONTES
# Saídas do switch: as 3 primeiras fontes têm nós próprios; as outras vão juntas
SAIDAS = {"linkedin": ["linkedin"], "gupy": ["gupy"], "remotive": ["remotive"], "novas": [*SITES_BR, *CARREIRAS]}
FILTRO = (SRC / "filtro_titulo.js").read_text(encoding="utf-8")
f1 = node("Quais fontes", "n8n-nodes-base.switch", 3.2, (200, 500), {"rules": {"values": [{
    "conditions": {
        "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
        "conditions": [{"id": nid(f"fonte-{saida}"),
                        "leftValue": "={{ String($json.fontes === 'todas' ? '" + " ".join(ATIVAS) + "' : $json.fontes)"
                                     ".split(' ').some(f => "
                                     + json.dumps([f for f in fs if f in ATIVAS]).replace('"', "'") + ".includes(f)) }}",
                        "rightValue": "", "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
        "combinator": "and",
    },
    "renameOutput": True, "outputKey": saida,
} for saida, fs in SAIDAS.items()]}, "looseTypeValidation": True, "options": {"allMatchingOutputs": True}})
liga(j1, f1)
RETRO = "$('Janela da coleta').first().json.retroativo === true"
# Janela (em dias) desta coleta quando ela é retroativa: /buscar N usa os últimos N dias
DIAS_JANELA = f"($('Janela da coleta').first().json.dias || {DIAS_RETRO})"

c1 = code("LinkedIn: buscar", (460, 0),
          js("linkedin_buscar.js", f"return await main(this.helpers, {RETRO}, {DIAS_JANELA});", FILTRO))
s1 = sql("Salvar (LinkedIn)", (720, 0), INSERT, PARAM_JSON)
liga(f1, c1, 0); liga(c1, s1)

c2 = code("Gupy: termos de busca", (460, 200), js("gupy_termos.js", f"return main({RETRO});"))
h2 = code("Gupy: buscar", (720, 200), js("gupy_buscar.js", "return await main($input.all(), this.helpers);"))
c2b = code("Gupy: normalizar", (980, 200), js("gupy_normalizar.js", f"return main($input.all(), {RETRO}, {DIAS_JANELA});", FILTRO))
s2 = sql("Salvar (Gupy)", (1240, 200), INSERT, PARAM_JSON)
liga(f1, c2, 1); liga(c2, h2); liga(h2, c2b); liga(c2b, s2)

REMOTIVE_CAT = urllib.parse.quote(CFG["termos_de_busca"]["remotive_categoria"])
h3 = get("Remotive: buscar", (460, 400), f"https://remotive.com/api/remote-jobs?category={REMOTIVE_CAT}&limit=200")
c3 = code("Remotive: normalizar", (720, 400), js("remotive_normalizar.js", f"return main($input.all(), {RETRO}, {DIAS_JANELA});", FILTRO))
s3 = sql("Salvar (Remotive)", (980, 400), INSERT, PARAM_JSON)
liga(f1, h3, 2); liga(h3, c3); liga(c3, s3)

# Sites brasileiros e páginas de carreira num nó só, em paralelo (src/fontes_novas.js)
FONTES_JANELA = "$('Janela da coleta').first().json.fontes"
cn = code("Sites e carreiras: buscar", (460, -200),
          js("fontes_novas.js", f"return await main(this.helpers, {FONTES_JANELA}, {RETRO}, {DIAS_JANELA});",
             "\n".join([FILTRO, *(fonte_js(f) for f in ("sites_buscar.js", "carreiras_buscar.js"))])))
sn = sql("Salvar (sites e carreiras)", (720, -200), INSERT, PARAM_JSON)
liga(f1, cn, 3); liga(cn, sn)


# ---------------------------------------------------------------- 2. Análise
# Uma vez por dia, pega tudo o que está pendente (coletas da noite anterior e da manhã)
t2 = agenda(f"Analisar ({HORA['analise']})", (0, 900), [HORA["analise"]])
# Perfil enviado pelo Telegram (lido pelo "Análise: montar requisição"); passa adiante as
# fontes pedidas no /buscar, que o "Pegar pendentes" usa.
s4 = sql("Perfil em uso", (130, 1060), PERFIL_EM_USO + ",\n  $1::text AS fontes;", PARAM_FONTES)
# Antes, marca como "duplicada" a pendente cujo link já foi analisado (ou que tem uma
# pendente mais antiga com o mesmo link): não gasta uma segunda chamada ao Gemini.
s5 = sql("Pegar pendentes", (260, 900), LINK_CHAVE + """UPDATE vagas d SET status = 'duplicada'
WHERE (d.status = 'pendente' OR (d.status = 'erro_llm' AND d.tentativas < 3))
  AND EXISTS (
    SELECT 1 FROM vagas o
    WHERE o.id <> d.id AND link_chave(o.link) = link_chave(d.link)
      AND (o.status = 'analisada'
           OR ((o.status = 'pendente' OR (o.status = 'erro_llm' AND o.tentativas < 3)) AND o.id < d.id))
  );
UPDATE vagas SET tentativas = tentativas + 1
WHERE id IN (
  SELECT id FROM vagas
  WHERE (status = 'pendente' OR (status = 'erro_llm' AND tentativas < 3))
    AND """ + FILTRO_FONTES.format(col="fonte") + """
  ORDER BY coletado_em
  LIMIT 300
  FOR UPDATE SKIP LOCKED
)
RETURNING id, fonte, id_externo, link, titulo, empresa, local, texto;""", PARAM_FONTES)
c5 = code("Análise: completar descrição", (520, 900),
          js("analise_completar.js", "return await main($input.all(), this.helpers);"))
i5 = node("Descrição ok?", "n8n-nodes-base.if", 2.2, (780, 900), {
    "conditions": {
        "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
        "conditions": [{"id": nid("cond-ok"), "leftValue": "={{ $json.ok }}", "rightValue": "",
                        "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
        "combinator": "and",
    },
    "looseTypeValidation": True, "options": {},
})
consts = f"const PERFIL = {json.dumps(PERFIL, ensure_ascii=False)};\nconst PROMPT = {json.dumps(PROMPT, ensure_ascii=False)};\n"
c6 = code("Análise: montar requisição", (1040, 820), js("analise_requisicao.js", "return main($input.all());", consts))
t6, r6 = gemini_com_reserva("Análise", "Análise: pontuar (Gemini)", (1300, 820))
c7 = code("Análise: interpretar", (2340, 820), js("analise_interpretar.js", "return main($input.all());", GEMINI_ERROS))
# Cobrança, chave, cota ou sobrecarga (depois dos modelos de reserva): um aviso no Telegram
c7a = code("Análise: avisar problema no Gemini", (2340, 620), js("gemini_aviso.js", "return main($input.all());", GEMINI_ERROS))
tg7a = telegram("Telegram: avisar problema no Gemini", (2600, 620))
s7 = sql("Salvar análise", (2600, 820), """UPDATE vagas v SET
  status = r.status,
  titulo = COALESCE(NULLIF(r.titulo, ''), v.titulo),
  empresa = COALESCE(NULLIF(r.empresa, ''), v.empresa),
  local = COALESCE(NULLIF(r.local, ''), v.local),
  texto = COALESCE(r.texto, v.texto),
  score = r.score,
  analise = r.analise,
  analisado_em = now()
FROM jsonb_to_record($1::jsonb) AS r(fonte text, id_externo text, status text, titulo text,
     empresa text, local text, texto text, score int, analise jsonb)
WHERE v.fonte = r.fonte AND v.id_externo = r.id_externo;""", "={{ [ JSON.stringify($json.registro) ] }}")
s8 = sql("Marcar sem leitura", (1040, 1000),
         "UPDATE vagas SET status = 'erro_fetch', analisado_em = now() WHERE id = $1::bigint;",
         "={{ [ $json.id ] }}")
liga(t2, s4); liga(s4, s5); liga(s5, c5); liga(c5, i5)
liga(i5, c6, 0); liga(i5, s8, 1)
liga(c6, t6); liga(r6, c7, 1); liga(r6, c7a, 1); liga(c7a, tg7a); liga(c7, s7)

# ---------------------------------------------------------------- 3. Resumo no Telegram
t3 = agenda(f"Resumo ({HORA['resumo']})", (0, 1300), [HORA["resumo"]])
# Sempre volta ao menos uma linha: a situação do banco vai junto, para o resumo vazio
# explicar o porquê (nada coletado? análise pendente?).
s9 = sql("Vagas a notificar", (260, 1300), """WITH situacao AS (
  SELECT count(*) FILTER (WHERE coletado_em > now() - interval '24 hours') AS coletadas_24h,
         count(*) FILTER (WHERE status = 'pendente' OR (status = 'erro_llm' AND tentativas < 3)) AS pendentes,
         max(coletado_em) AS ultima_coleta
  FROM vagas
  WHERE """ + FILTRO_FONTES.format(col="fonte") + """
)
SELECT v.id, v.fonte, v.id_externo, v.link, v.titulo, v.empresa, v.local, v.score, v.analise, v.status,
       s.coletadas_24h, s.pendentes, s.ultima_coleta, $1::text AS fontes_pedidas
FROM situacao s
LEFT JOIN vagas v ON v.notificada = false
  AND (v.status IN ('analisada', 'erro_fetch') OR (v.status = 'erro_llm' AND v.tentativas >= 3))
  AND """ + FILTRO_FONTES.format(col="v.fonte") + """
ORDER BY v.score DESC NULLS LAST;""", PARAM_FONTES, alwaysOutputData=True)
c9 = code("Resumo: montar mensagens", (520, 1300), js("notificar_montar.js", "return main($input.all());"))
tg = telegram("Telegram: enviar", (780, 1300))
s10 = sql("Marcar notificadas", (1040, 1300),
          "UPDATE vagas SET notificada = true\nWHERE id = ANY(string_to_array(NULLIF($1, ''), ',')::bigint[]);",
          "={{ [ $('Resumo: montar mensagens').first().json.ids ] }}", executeOnce=True)
liga(t3, s9); liga(s9, c9); liga(c9, tg); liga(tg, s10)

# ---------------------------------------------------------------- 4. Aviso de início
# Dispara quando o n8n liga (servidor reiniciado, atualização) e quando o workflow é
# publicado: confirma no Telegram que o bot está no ar.
t4 = node("Bot iniciado", "n8n-nodes-base.n8nTrigger", 1, (0, 1600),
          {"events": ["init", "activate", "update"]})
SITUACAO = """SELECT count(*) AS total,
  count(*) FILTER (WHERE status = 'pendente' OR (status = 'erro_llm' AND tentativas < 3)) AS pendentes,
  count(*) FILTER (WHERE notificada = false AND (status IN ('analisada', 'erro_fetch') OR (status = 'erro_llm' AND tentativas >= 3))) AS a_notificar,
  max(coletado_em) AS ultima_coleta,
  max(analisado_em) AS ultima_analise
FROM vagas;"""
s11 = sql("Situação do banco", (260, 1600), SITUACAO, alwaysOutputData=True, onError="continueRegularOutput")
c11 = code("Aviso: montar mensagem", (520, 1600),
           js("aviso_inicio.js", "return main($('Bot iniciado').first().json, $input.first().json);"))
tg2 = telegram("Telegram: avisar início", (780, 1600))
liga(t4, s11); liga(s11, c11); liga(c11, tg2)

# ---------------------------------------------------------------- 5. Comandos no Telegram
# O container telegram (servidor/telegram_comandos.py) lê as suas mensagens e chama este
# webhook pela rede interna do compose (nada exposto na internet). O webhook exige o
# cabeçalho X-Bot-Vagas-Segredo (credencial "Comando", criada pelo n8n_montar.py com o
# N8N_COMANDO_SEGREDO do .env): sem ele, qualquer processo que alcance o n8n poderia
# disparar coletas ou trocar o perfil usado nas notas.
t5 = node("Comando (Telegram)", "n8n-nodes-base.webhook", 2, (0, 1900), {
    "httpMethod": "POST", "path": "bot-vagas-comando", "responseMode": "onReceived",
    "authentication": "headerAuth", "options": {},
}, webhookId=nid("webhook-comando"))
c12 = code("Comando: interpretar", (260, 1900),
           js("comando_interpretar.js", "return main($input.first().json);"))
w12 = escolha("Qual comando", (520, 1900), "acao",
             ["vagas", "buscar", "recentes", "status", "ajuda", "curriculo", "usar", "perfil"])
liga(t5, c12); liga(c12, w12)

# /vagas: o mesmo resumo das 09:30, agora
liga(w12, s9, 0)

# /buscar: avisa, coleta, analisa e manda o resumo, uma etapa depois da outra
c13 = code("Buscar: avisar", (780, 2000),
           "const cmd = $('Comando: interpretar').first().json;\n"
           "const r = cmd.retroativo === true;\n"
           "return [{ json: { texto: '🔎 Buscando vagas agora (' + (cmd.nomesFontes || 'todas as fontes') + ')' + "
           f"(r ? ', dos últimos ' + (cmd.dias || {DIAS_RETRO}) + ' dias' : '') + '. Depois vem a análise, uns 6 s por vaga; ' + "
           "'o resumo chega no fim' + ((cmd.fontes || []).length ? ', só com estas fontes (as outras ficam para as "
           + HORA["resumo"] + ").' : '.') } }];")
tg3 = telegram("Telegram: avisar busca", (1040, 2000))
e1c, e1 = etapa("Executar coleta", (1300, 2000), "coleta")
e2c, e2 = etapa("Executar análise", (1820, 2000), "analise")
e3c, e3 = etapa("Executar resumo", (2340, 2000), "resumo")
liga(w12, c13, 1); liga(c13, tg3); liga(tg3, e1c); liga(e1, e2c); liga(e2, e3c)

# /recentes [dias]: as melhores já analisadas, mesmo as enviadas (não marca nada)
s14 = sql("Analisadas recentes", (780, 2200), """SELECT id, fonte, id_externo, link, titulo, empresa, local, score, analise, status
FROM vagas
WHERE status = 'analisada' AND analisado_em >= now() - make_interval(days => $1::int)
ORDER BY score DESC NULLS LAST;""", "={{ [ $json.dias ] }}", alwaysOutputData=True)
c14 = code("Recentes: montar mensagens", (1040, 2200), js("notificar_montar.js", """const DIAS = $('Comando: interpretar').first().json.dias;
return main($input.all(), {
  titulo: `Melhores dos últimos ${DIAS} dia${DIAS > 1 ? 's' : ''}`,
  vazio: `🎯 Nenhuma vaga analisada nos últimos ${DIAS} dia${DIAS > 1 ? 's' : ''}.`,
});"""))
tg4 = telegram("Telegram: enviar recentes", (1300, 2200))
liga(w12, s14, 2); liga(s14, c14); liga(c14, tg4)

# /status: a mesma mensagem do aviso de início
s15 = sql("Situação do banco (status)", (780, 2400), SITUACAO, alwaysOutputData=True, onError="continueRegularOutput")
c15 = code("Status: montar mensagem", (1040, 2400),
           js("aviso_inicio.js", "return main({ event: 'status' }, $input.first().json);"))
tg5 = telegram("Telegram: enviar status", (1300, 2400))
liga(w12, s15, 3); liga(s15, c15); liga(c15, tg5)

# /ajuda e comando desconhecido: o texto já vem pronto
tg6 = telegram("Telegram: enviar ajuda", (780, 2600))
liga(w12, tg6, 4)

# PDF do currículo (o container telegram baixa e manda em base64): o Gemini monta um perfil
# novo, que fica como rascunho até o /usar
PERFIL_JS = fonte_js("perfil_mensagens.js")
c20 = code("Currículo: avisar", (780, 2800),
           "const a = ($('Comando (Telegram)').first().json.body || {}).arquivo || {};\n"
           "return [{ json: { texto: '📄 Recebi \"' + String(a.nome || 'o currículo').replace(/[<>&]/g, '') + "
           "'\". Lendo com o Gemini; o perfil novo chega em até 1 minuto para você conferir.' } }];")
tg20 = telegram("Telegram: avisar currículo", (1040, 2800))
s20 = sql("Perfil em uso (currículo)", (1300, 2800), PERFIL_EM_USO + ";")
c21 = code("Currículo: montar pedido", (1560, 2800), js(
    "curriculo_requisicao.js", "return main($('Comando (Telegram)').first().json, $input.first().json);",
    f"const PERFIL = {json.dumps(PERFIL, ensure_ascii=False)};\n"
    f"const PROMPT_CURRICULO = {json.dumps(configuracao.prompt_curriculo(ARGS.config), ensure_ascii=False)};\n"))
t21, r21 = gemini_com_reserva("Currículo", "Currículo: ler (Gemini)", (1820, 2800), timeout=180000)
# Todos os modelos sobrecarregados ou sem cota: avisa e tenta de novo em 2, 5 e 10 min
c21b = code("Currículo: tentar mais tarde?", (2860, 2600),
            js("curriculo_reagendar.js", "return main($input.first().json);", GEMINI_ERROS))
i21 = se("Currículo: esperar?", (3120, 2600), "esperar")
tg21 = telegram("Telegram: avisar nova tentativa", (3380, 2450))
w21 = node("Currículo: esperar", "n8n-nodes-base.wait", 1.1, (3380, 2600),
           {"amount": "={{ $json.esperar_min }}", "unit": "minutes"}, webhookId=nid("espera-curriculo"))
c22 = code("Currículo: interpretar", (2860, 2800),
           js("curriculo_interpretar.js", "return main($input.first().json);", GEMINI_ERROS))
s22 = sql("Salvar rascunho do perfil", (3120, 2800), PERFIS + """WITH r AS (
  SELECT * FROM jsonb_to_record($1::jsonb) AS r(ok boolean, perfil text, origem text)
  WHERE r.ok AND coalesce(r.perfil, '') <> ''
), d AS (
  UPDATE perfis SET status = 'descartado' WHERE status = 'rascunho' AND EXISTS (SELECT 1 FROM r)
)
INSERT INTO perfis (texto, origem) SELECT perfil, origem FROM r
RETURNING id, criado_em;""", PARAM_JSON, alwaysOutputData=True)
c23 = code("Currículo: montar resposta", (3380, 2800), js(
    "perfil_mensagens.js", "return respostaCurriculo($('Currículo: interpretar').first().json, $input.first().json);",
    f"const PERFIL = {json.dumps(PERFIL, ensure_ascii=False)};"))
tg23 = telegram("Telegram: enviar perfil novo", (3640, 2800))
liga(w12, c20, 5); liga(c20, tg20); liga(tg20, s20); liga(s20, c21); liga(c21, t21); liga(r21, c21b, 1); liga(c21b, i21)
liga(i21, tg21, 0); liga(i21, w21, 0); liga(w21, t21); liga(i21, c22, 1)
liga(c22, s22); liga(s22, c23); liga(c23, tg23)

# /usar: o último rascunho passa a ser o perfil em uso
s24 = sql("Usar perfil novo", (780, 3000), PERFIS + """WITH r AS (
  SELECT id FROM perfis WHERE status = 'rascunho' ORDER BY id DESC LIMIT 1
), a AS (
  UPDATE perfis SET status = 'antigo' WHERE status = 'ativo' AND EXISTS (SELECT 1 FROM r)
), u AS (
  UPDATE perfis SET status = 'ativo' WHERE id IN (SELECT id FROM r) RETURNING id, criado_em
)
SELECT (SELECT count(*) FROM u) AS ativados, (SELECT criado_em FROM u) AS criado_em;""")
c24 = code("Usar: montar mensagem", (1040, 3000), js("perfil_mensagens.js", "return respostaUsar($input.first().json);",
                                                       f"const PERFIL = {json.dumps(PERFIL, ensure_ascii=False)};"))
tg24 = telegram("Telegram: enviar uso do perfil", (1300, 3000))
liga(w12, s24, 6); liga(s24, c24); liga(c24, tg24)

# /perfil (resumo do em uso), /perfil completo, /perfil novo (o rascunho) e /perfil arquivo
# (volta ao config/perfil.md)
s25 = sql("Perfil (comando)", (780, 3200), PERFIS + """UPDATE perfis SET status = 'antigo' WHERE status = 'ativo' AND $1::text = 'arquivo';
""" + PERFIL_EM_USO.split(");\n", 1)[1] + ",\n"
          "  (SELECT texto FROM perfis WHERE status = 'rascunho' ORDER BY id DESC LIMIT 1) AS rascunho,\n  $1::text AS pedido;", "={{ [ $json.pedido || 'ver' ] }}")
c25 = code("Perfil: montar mensagem", (1040, 3200), js("perfil_mensagens.js", "return respostaPerfil($input.first().json);",
                                                         f"const PERFIL = {json.dumps(PERFIL, ensure_ascii=False)};"))
tg25 = telegram("Telegram: enviar perfil", (1300, 3200))
liga(w12, s25, 7); liga(s25, c25); liga(c25, tg25)

# Etapas chamadas pelo /buscar (Execute Workflow neste mesmo workflow)
t6 = node("Etapa (chamada interna)", "n8n-nodes-base.executeWorkflowTrigger", 1.1, (0, 3500),
          {"inputSource": "passthrough"})
w16 = escolha("Qual etapa", (260, 3500), "etapa", ["coleta", "analise", "resumo"])
liga(t6, w16)
liga(w16, j1, 0)  # a mesma entrada da coleta agendada
liga(w16, s4, 1)
liga(w16, s9, 2)

workflow = {
    "name": "Bot de vagas" + (f" — {CFG['nome'].strip()}" if CFG["nome"].strip() else ""),
    "nodes": nodes,
    "connections": conexoes,
    "settings": {"executionOrder": "v1", "timezone": "America/Sao_Paulo",
                 "callerPolicy": "workflowsFromSameOwner"},
    "pinData": {},
}
Path(ARGS.saida).write_text(json.dumps(workflow, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"{Path(ARGS.saida).name} gerado com {len(nodes)} nós ({len(ATIVAS)} fonte(s) ligada(s))")
