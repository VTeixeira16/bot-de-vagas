#!/usr/bin/env bash
# Diagnóstico da coleta: o que tem no banco, o que cada fonte devolve agora (consultada
# daqui do servidor, como o n8n faz) e o que as últimas execuções do n8n fizeram em cada
# nó. Só lê; não grava nada no banco nem no n8n. Rode na pasta do repositório:
#
#   bash servidor/diagnostico.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Versão =="
echo "branch $(git rev-parse --abbrev-ref HEAD), commit $(git log -1 --format='%h %ad' --date=format:'%d/%m %H:%M')"

echo
echo "== Comandos do Telegram =="
# Só diz se as variáveis estão preenchidas; os valores não aparecem
for v in TELEGRAM_TOKEN TELEGRAM_CHAT_ID; do
  if grep -q "^$v=.\+" .env 2>/dev/null; then echo "$v no .env: sim"; else echo "$v no .env: NÃO"; fi
done
docker compose ps telegram 2>&1 | tail -n +2 || true
docker compose exec -T telegram sh -c 'test -n "$TELEGRAM_TOKEN" && echo "token no container: sim" || echo "token no container: NÃO (rode: docker compose up -d --force-recreate telegram)"' 2>&1 || true
docker compose logs --tail 15 telegram 2>&1 || true

echo
echo "== Banco =="
docker compose exec -T postgres psql -U vagas -d vagas -X -P pager=off -c "
SELECT (SELECT count(*) FROM vagas) AS vagas,
       (SELECT count(*) FROM vagas WHERE status = 'pendente') AS pendentes,
       (SELECT count(*) FROM vagas WHERE status = 'duplicada') AS duplicadas,
       (SELECT max(coletado_em)::timestamp(0) FROM vagas) AS ultima_coleta,
       to_regclass('coletas') IS NOT NULL AS tabela_coletas;" || true
if docker compose exec -T postgres psql -U vagas -d vagas -XtAc "SELECT to_regclass('perfis') IS NOT NULL" | grep -q t; then
  echo "Perfis mandados pelo Telegram (o 'ativo' vale no lugar do config/perfil.md):"
  docker compose exec -T postgres psql -U vagas -d vagas -X -P pager=off \
    -c "SELECT id, status, origem, criado_em::timestamp(0) AS criado_em, length(texto) AS caracteres FROM perfis ORDER BY id DESC LIMIT 5;"
fi
if docker compose exec -T postgres psql -U vagas -d vagas -XtAc "SELECT to_regclass('coletas') IS NOT NULL" | grep -q t; then
  docker compose exec -T postgres psql -U vagas -d vagas -X -P pager=off \
    -c "SELECT id, iniciada_em::timestamp(0) AS iniciada_em, retroativo FROM coletas ORDER BY id DESC LIMIT 5;"
fi

echo
echo "== Configuração (config/) =="
python3 configuracao.py || true

echo
echo "== Fontes (consultadas agora, daqui do servidor) =="
python3 - <<'PY'
import json, re, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

sys.path.insert(0, ".")
import configuracao  # noqa: E402

try:
    CFG = configuracao.carregar()[0]
except configuracao.ErroConfig as e:
    sys.exit(f"Sem configuração válida, não dá para testar as fontes:\n{e}")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # noqa: BLE001 - mostra qualquer falha de rede
        return f"falha: {e}", ""

def dias(iso):
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - t).total_seconds() / 86400
    except Exception:  # noqa: BLE001
        return None

def tem_termo(texto, termos):
    """Como o temTermo do src/util.js: palavra inteira, ou começo de palavra com * no fim."""
    t = f" {configuracao.normalizar(texto)} "
    for termo in termos:
        n = configuracao.normalizar(termo.rstrip("*"))
        if n and f" {n}{'' if termo.endswith('*') else ' '}" in t:
            return True
    return False

def titulo_de_interesse(titulo):
    """Como o tituloDeInteresse do src/filtro_titulo.js (sem o descarte de estágio etc.)."""
    f = CFG["filtro_titulo"]
    if tem_termo(titulo, f["recusar"]):
        return False
    grupos = f["ou_ter_um_de_cada_grupo"]
    if not f["basta_ter"] and not grupos:
        return True
    return tem_termo(titulo, f["basta_ter"]) or (bool(grupos) and all(tem_termo(titulo, g) for g in grupos))

def lista_js(arquivo, nome):
    txt = open(arquivo, encoding="utf-8").read()
    corpo = re.search(nome + r"\s*=\s*\[(.*?)\];", txt, re.S).group(1)
    corpo = "\n".join(l for l in corpo.splitlines() if not l.strip().startswith("//"))
    return re.findall(r"'([^']*)'", corpo)

# LinkedIn: mesma URL pública que o nó "LinkedIn: buscar" monta
IGNORAR = {"currentJobId", "origin", "refresh", "start", "trk", "trackingId", "refId", "eBP", "position", "pageNum"}
for i, link in enumerate(CFG["linkedin_buscas"], 1):
    q = [(k, v) for k, v in urllib.parse.parse_qsl(urllib.parse.urlsplit(link).query) if k not in IGNORAR]
    p = dict(q)
    p.setdefault("geoId", "106057199")  # Brasil (location=Brasil devolve vagas dos EUA)
    for janela, rotulo in (("r86400", "24 h"), ("r7776000", "90 dias")):
        p2 = {**p, "f_TPR": janela, "start": "0"}
        url = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?" + urllib.parse.urlencode(p2)
        st, html = get(url)
        n = len(set(re.findall(r"urn:li:jobPosting:(\d{8,12})", html)))
        print(f"LinkedIn busca {i} ({rotulo}): HTTP {st}, {n} vagas na 1ª página (máx. 10)")
        time.sleep(3)

# Gupy: um termo por vez, como o nó "Gupy: buscar", no primeiro endereço que responder
termos = list(dict.fromkeys(CFG["termos_de_busca"]["cargos"] + CFG["termos_de_busca"]["assuntos"])) or ["tech lead"]
apis = lista_js("src/gupy_buscar.js", "GUPY_APIS")
api = apis[0]
for base in apis:
    st, _ = get(base + "?" + urllib.parse.urlencode({"jobName": termos[0], "limit": 10, "offset": 0}))
    print(f"Gupy endereço {base}: HTTP {st}")
    if st == 200:
        api = base
        break
    time.sleep(1.5)
tot3 = tot90 = 0
for termo in termos:
    st, corpo = get(api + "?" + urllib.parse.urlencode({"jobName": termo, "limit": 100, "offset": 0}))
    try:
        dados = json.loads(corpo).get("data", [])
    except ValueError:
        dados = []
    idades = [dias(v.get("publishedDate") or v.get("publishedAt")) for v in dados]
    a3 = sum(1 for d in idades if d is None or d <= 3)
    a90 = sum(1 for d in idades if d is None or d <= 90)
    tot3 += a3; tot90 += a90
    print(f"Gupy '{termo}': HTTP {st}, {len(dados)} vagas, {a3} de até 3 dias, {a90} de até 90 dias")
    time.sleep(1.5)
print(f"Gupy total (com repetidas): {tot3} de até 3 dias, {tot90} de até 90 dias")

# Remotive
st, corpo = get("https://remotive.com/api/remote-jobs?limit=200&category="
                + urllib.parse.quote(CFG["termos_de_busca"]["remotive_categoria"]))
try:
    jobs = json.loads(corpo).get("jobs", [])
except ValueError:
    jobs = []
filtro = [j for j in jobs if titulo_de_interesse(j.get("title", ""))]
recentes = [j for j in filtro if (dias(j.get("publication_date")) or 0) <= 3]
print(f"Remotive: HTTP {st}, {len(jobs)} vagas, {len(filtro)} passam no filtro de título, {len(recentes)} delas de até 3 dias")

# Sites brasileiros (src/sites_buscar.js): a busca do primeiro cargo em cada um, contando os cartões
termo = (CFG["termos_de_busca"]["cargos"] or ["tech lead"])[0]
slug = configuracao.normalizar(termo).replace(" ", "-")
mais = urllib.parse.quote_plus(termo)
sites = [
    ("InfoJobs", f"https://www.infojobs.com.br/empregos.aspx?palabra={mais}", r'<div id="vacancy\d+'),
    ("Catho", f"https://www.catho.com.br/vagas/{slug}/", r'<li data-offer-item="\d+'),
    ("Vagas.com", f"https://www.vagas.com.br/vagas-de-{slug}", r'data-id-vaga="\d+'),
    ("Remotar", f"https://api.remotar.com.br/jobs?search={urllib.parse.quote(termo)}&page=1", "data"),
    ("Trampos", f"https://trampos.co/api/v2/opportunities?tr={mais}&page=1", "opportunities"),
]
for nome, url, padrao in sites:
    st, corpo = get(url)
    if padrao in ("data", "opportunities"):  # API JSON: lista nessa chave
        try:
            n = len(json.loads(corpo).get(padrao) or [])
        except ValueError:
            n = 0
    else:
        n = len(re.findall(padrao, corpo))
    print(f"{nome} '{termo}': HTTP {st}, {n} vagas na 1ª página")
    time.sleep(2)

# Páginas de carreira (src/carreiras_buscar.js): a primeira empresa de cada plataforma, vagas abertas
URLS_CARREIRA = {
    "greenhouse": ("Greenhouse", "https://boards-api.greenhouse.io/v1/boards/{}/jobs", "jobs"),
    "lever": ("Lever", "https://api.lever.co/v0/postings/{}?mode=json", None),
    "workable": ("Workable", "https://apply.workable.com/api/v1/widget/accounts/{}", "jobs"),
}
carreiras = []
for plat, (rotulo, modelo, chave) in URLS_CARREIRA.items():
    empresas = list(CFG["paginas_de_carreira"][plat])
    if empresas:
        carreiras.append((f"{rotulo} ({empresas[0]})", modelo.format(empresas[0]), chave))
for nome, url, chave in carreiras:
    st, corpo = get(url)
    try:
        d = json.loads(corpo)
        n = len((d.get(chave) if chave else d) or [])
    except (ValueError, AttributeError):
        n = 0
    print(f"{nome}: HTTP {st}, {n} vagas abertas")
    time.sleep(1.5)
PY

echo
echo "== Últimas execuções do n8n (itens que cada nó devolveu) =="
VOL="$(docker volume inspect bot-vagas_dados_n8n --format '{{ .Mountpoint }}')"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if sudo test -f "$VOL/database.sqlite"; then
  # Copia (com o WAL) para ler sem mexer no banco do n8n em uso
  sudo sh -c "cp '$VOL'/database.sqlite* '$TMP'/ && chown -R $(id -u) '$TMP'"
  python3 - "$TMP/database.sqlite" <<'PY'
import json, sqlite3, sys
from datetime import datetime, timedelta, timezone

db = sqlite3.connect(sys.argv[1])
db.row_factory = sqlite3.Row
BRT = timezone(timedelta(hours=-3))

def hora(txt):
    if not txt:
        return "-"
    t = datetime.fromisoformat(str(txt).replace("Z", "").replace(" ", "T")[:19]).replace(tzinfo=timezone.utc)
    return t.astimezone(BRT).strftime("%d/%m %H:%M")

def desachatar(txt):
    """Formato 'flatted' que o n8n usa no execution_data."""
    arr = json.loads(txt)
    memo = {}
    def idx(i):
        if i in memo:
            return memo[i]
        x = arr[i]
        if isinstance(x, dict):
            memo[i] = out = {}
            for k, v in x.items():
                out[k] = val(v)
            return out
        if isinstance(x, list):
            memo[i] = out = []
            out.extend(val(v) for v in x)
            return out
        return x
    def val(v):
        return idx(int(v)) if isinstance(v, str) else v
    return idx(0)

cols = {r[1] for r in db.execute("PRAGMA table_info(execution_entity)")}
inicio = "startedAt" if "startedAt" in cols else "createdAt"
rows = db.execute(f"SELECT id, mode, status, {inicio} AS inicio, stoppedAt FROM execution_entity ORDER BY id DESC LIMIT 12").fetchall()
if not rows:
    print("nenhuma execução registrada")
for r in rows:
    print(f"\n#{r['id']} {hora(r['inicio'])} → {hora(r['stoppedAt'])}  {r['mode']}  {r['status']}")
    d = db.execute("SELECT data FROM execution_data WHERE executionId = ?", (r["id"],)).fetchone()
    if not d or not d["data"]:
        print("   (sem dados da execução)")
        continue
    try:
        res = desachatar(d["data"]).get("resultData", {})
    except Exception as e:  # noqa: BLE001
        print(f"   (não consegui ler os dados: {e})")
        continue
    if res.get("error"):
        print(f"   ERRO: {str(res['error'].get('message', res['error']))[:200]}")
    for no, execs in (res.get("runData") or {}).items():
        for ex in execs or []:
            saida = ((ex.get("data") or {}).get("main") or [[]])
            n = sum(len(s or []) for s in saida)
            erros = [i["json"].get("error") for s in saida for i in (s or []) if isinstance(i, dict) and isinstance(i.get("json"), dict) and i["json"].get("error")]
            extra = ""
            if ex.get("error"):
                extra = f"  ERRO: {str(ex['error'].get('message', ex['error']))[:160]}"
            elif erros:
                extra = f"  ({len(erros)} com erro, ex.: {str(erros[0])[:120]})"
            avisos = [i["json"]["aviso"] for s in saida for i in (s or []) if isinstance(i, dict) and isinstance(i.get("json"), dict) and i["json"].get("aviso")]
            if avisos:
                n -= len(avisos)
                extra += f"  AVISO: {str(avisos[0])[:200]}"
            print(f"   {no}: {n} itens{extra}")
PY
else
  echo "não achei o banco do n8n em $VOL (veja as execuções em http://localhost:5679, aba Executions)"
fi
