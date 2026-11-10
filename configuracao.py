"""Lê e confere a configuração do bot: config/config.json, config/perfil.md e (opcional)
config/prompt.md. Usado pelo build.py; também dá para rodar sozinho:

  python3 configuracao.py              confere a configuração e diz o que está errado
  python3 configuracao.py --mostrar    mostra a configuração completa (com os padrões)

O que faltar no config.json vem dos padrões abaixo, então opções novas não quebram a
configuração de ninguém. Campos que começam com "_" (como "_ajuda") são só comentários.
"""
import copy
import json
import re
import sys
import unicodedata
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
PASTA_PADRAO = RAIZ / "config"
EXEMPLO = RAIZ / "exemplo"

FONTES = ["linkedin", "gupy", "remotive", "infojobs", "catho", "vagas.com", "remotar", "trampos",
          "greenhouse", "lever", "workable"]
PLATAFORMAS = ["greenhouse", "lever", "workable"]
SENIORIDADES = {  # valor do schema -> como aparece no prompt
    "junior_ou_abaixo": "estágio, trainee, júnior", "pleno": "pleno", "senior": "sênior",
    "especialista_staff": "especialista/staff", "lideranca_tecnica": "liderança técnica",
    "coordenacao": "coordenação", "gerencia": "gerência", "head_diretoria": "head/diretoria",
}
class _Obrigatorio:
    def __deepcopy__(self, memo):
        return self  # continua sendo o mesmo marcador depois de copiar os padrões


OBRIGATORIO = _Obrigatorio()

PADRAO = {
    "nome": "",
    "modelo_gemini": "gemini-flash-latest",
    # Tentados na ordem quando o modelo_gemini responde cota estourada (429) ou sobrecarga
    # (5xx); no plano gratuito, cada modelo tem a própria cota
    "modelos_reserva": ["gemini-flash-lite-latest"],
    "horarios": {"coleta": ["07:00", "19:00"], "analise": "07:30", "resumo": "09:30"},
    "resumo": {"nota_minima": 70, "max_vagas": 20},
    "fontes": {f: True for f in FONTES},
    "linkedin_buscas": [],
    "termos_de_busca": {"cargos": [], "assuntos": [], "remotive_categoria": "software-dev"},
    "paginas_de_carreira": {p: {} for p in PLATAFORMAS},
    "filtro_titulo": {"basta_ter": [], "ou_ter_um_de_cada_grupo": [], "recusar": []},
    "descartar_titulos": {
        "com": ["estagiário", "estagiária", "estágio", "trainee", "júnior", "jr", "aprendiz", "intern", "internship"],
        "comecando_com": ["assistente", "auxiliar", "atendente", "operador", "vendedor", "promotor"],
    },
    "locais_de_interesse": {"palavras": [], "paises": []},
    "avaliacao": {
        "regiao": OBRIGATORIO,
        "areas": OBRIGATORIO,
        "pontos_area": OBRIGATORIO,
        "pontos_senioridade": "coordenação, gerência, liderança técnica, staff, especialista, principal = 25; "
                              "head/diretoria = 18; sênior sem liderança = 12; pleno ou abaixo = 0",
        "senioridades_com_teto": ["junior_ou_abaixo", "pleno"],
    },
}
# Mapas cujas chaves você escolhe (empresa -> nome): não são conferidas contra o padrão
MAPAS_LIVRES = {"paginas_de_carreira.greenhouse", "paginas_de_carreira.lever", "paginas_de_carreira.workable"}

DICAS_JSON = [
    ("Expecting ',' delimiter", "falta uma vírgula no fim da linha anterior (ou uma aspa ficou aberta)"),
    ("Expecting property name enclosed in double quotes",
     "vírgula sobrando antes de } ou nome de campo sem aspas duplas"),
    ("Illegal trailing comma", "vírgula sobrando antes de ] ou }"),
    ("Expecting value", "falta um valor, ou há vírgula sobrando antes de ] ou }"),
    ("Expecting ':' delimiter", "falta o : entre o nome do campo e o valor"),
    ("Unterminated string", "um texto abriu aspas e não fechou"),
    ("Invalid control character", "quebra de linha dentro de um texto entre aspas"),
    ("Extra data", "sobrou algo depois do último }"),
    ("Invalid \\escape", "barra invertida \\ dentro de um texto: use \\\\ ou tire a barra"),
]


class ErroConfig(Exception):
    pass


def normalizar(txt):
    """Como o normalizarChave do src/util.js: sem acento, minúsculas, só letras e números."""
    t = unicodedata.normalize("NFD", str(txt or ""))
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def ler_json(arquivo):
    texto = arquivo.read_text(encoding="utf-8-sig")
    try:
        return json.loads(texto)
    except json.JSONDecodeError as e:
        dica = next((d for chave, d in DICAS_JSON if e.msg.startswith(chave)), e.msg)
        linhas = texto.splitlines()
        trecho = linhas[e.lineno - 1] if 0 < e.lineno <= len(linhas) else ""
        raise ErroConfig(f"{arquivo.name}, linha {e.lineno}, coluna {e.colno}: {dica}.\n"
                         f"    {trecho.strip()}\n"
                         "  (o erro pode estar no fim da linha anterior)") from None


def _tipo(v):
    if isinstance(v, bool):
        return "true/false"
    if isinstance(v, int):
        return "número"
    if isinstance(v, str):
        return "texto entre aspas"
    if isinstance(v, list):
        return "lista [ ... ]"
    if isinstance(v, dict):
        return "grupo { ... }"
    return type(v).__name__


def mesclar(padrao, dado, caminho, erros, avisos):
    """Junta o config.json com os padrões, conferindo nomes e tipos."""
    if not isinstance(dado, dict):
        erros.append(f"{caminho or 'o arquivo'}: esperava {_tipo(padrao)}, veio {_tipo(dado)}")
        return copy.deepcopy(padrao)
    saida = {}
    for k, v in padrao.items():
        nome = f"{caminho}.{k}" if caminho else k
        if k not in dado and isinstance(v, dict) and nome not in MAPAS_LIVRES:
            saida[k] = mesclar(v, {}, nome, erros, avisos)  # confere os obrigatórios lá dentro
            continue
        if k not in dado:
            if v is OBRIGATORIO:
                erros.append(f"{nome}: campo obrigatório que está faltando")
            saida[k] = copy.deepcopy(v)
            continue
        u = dado[k]
        if isinstance(v, dict) and nome not in MAPAS_LIVRES:
            saida[k] = mesclar(v, u, nome, erros, avisos)
        elif v is OBRIGATORIO or _tipo(v) == _tipo(u):
            saida[k] = u
        elif isinstance(v, list) and isinstance(u, str):
            saida[k] = [u]  # um texto só no lugar de uma lista
        elif nome in MAPAS_LIVRES and isinstance(u, list):
            saida[k] = {str(x): "" for x in u}  # lista de empresas sem nome
        else:
            erros.append(f"{nome}: esperava {_tipo(v)}, veio {_tipo(u)}")
            saida[k] = copy.deepcopy(v)
    for k in dado:
        if k not in padrao and not str(k).startswith("_"):
            nome = f"{caminho}.{k}" if caminho else k
            avisos.append(f"{nome}: campo desconhecido, ignorado (erro de digitação?)")
    return saida


def _lista_textos(valor, nome, erros, vazia_ok=True):
    if not isinstance(valor, list) or not all(isinstance(x, str) and x.strip() for x in valor):
        erros.append(f"{nome}: esperava uma lista de textos, como [\"um\", \"dois\"], sem textos vazios")
        return []
    if not vazia_ok and not valor:
        erros.append(f"{nome}: a lista não pode ficar vazia")
    return [x.strip() for x in valor]


def _hora(valor, nome, erros):
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(valor).strip()) if isinstance(valor, str) else None
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        erros.append(f"{nome}: horário inválido \"{valor}\" (use HH:MM, como \"07:30\")")
        return "00:00"
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def conferir(cfg, erros, avisos):
    """Confere os valores e devolve a configuração arrumada (ids das áreas, horários...)."""
    h = cfg["horarios"]
    h["coleta"] = sorted({_hora(x, "horarios.coleta", erros) for x in _lista_textos(h["coleta"], "horarios.coleta", erros, False)})
    h["analise"] = _hora(h["analise"], "horarios.analise", erros)
    h["resumo"] = _hora(h["resumo"], "horarios.resumo", erros)

    r = cfg["resumo"]
    if not 0 <= r["nota_minima"] <= 100:
        erros.append("resumo.nota_minima: use um número de 0 a 100")
    if not 1 <= r["max_vagas"] <= 100:
        erros.append("resumo.max_vagas: use um número de 1 a 100")

    if not str(cfg["modelo_gemini"]).strip():
        erros.append("modelo_gemini: não pode ficar vazio")
    cfg["modelo_gemini"] = str(cfg["modelo_gemini"]).strip()
    cfg["modelos_reserva"] = _lista_textos(cfg["modelos_reserva"], "modelos_reserva", erros)
    for m in [cfg["modelo_gemini"], *cfg["modelos_reserva"]]:
        if m and not re.fullmatch(r"[a-z0-9][a-z0-9.\-]*", m):
            erros.append(f"modelo \"{m}\": nome inválido (use o nome do modelo, como gemini-flash-latest)")
    if not any(cfg["fontes"].values()):
        erros.append("fontes: todas estão desligadas (false)")

    cfg["linkedin_buscas"] = _lista_textos(cfg["linkedin_buscas"], "linkedin_buscas", erros)
    for i, link in enumerate(cfg["linkedin_buscas"], 1):
        if not re.match(r"https?://([a-z]+\.)?linkedin\.com/", link):
            erros.append(f"linkedin_buscas, link {i}: não é um link do LinkedIn")
        elif "/jobs/collections/" in link:
            avisos.append(f"linkedin_buscas, link {i}: páginas /jobs/collections/ só existem com login e não funcionam")
    if cfg["fontes"]["linkedin"] and not cfg["linkedin_buscas"]:
        avisos.append("LinkedIn ligado sem nenhuma busca em linkedin_buscas: não vai trazer vagas")

    t = cfg["termos_de_busca"]
    t["cargos"] = _lista_textos(t["cargos"], "termos_de_busca.cargos", erros)
    t["assuntos"] = _lista_textos(t["assuntos"], "termos_de_busca.assuntos", erros)
    if not t["cargos"] and not t["assuntos"]:
        avisos.append("termos_de_busca sem nenhum termo: Gupy e sites brasileiros não vão trazer vagas")

    for p in PLATAFORMAS:
        mapa = cfg["paginas_de_carreira"][p]
        for empresa, nome_exibido in list(mapa.items()):
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", empresa):
                erros.append(f"paginas_de_carreira.{p}: \"{empresa}\" não parece um identificador "
                             "(é a parte do endereço depois da última barra, sem espaços)")
            if not isinstance(nome_exibido, str):
                erros.append(f"paginas_de_carreira.{p}.{empresa}: o nome exibido é um texto (\"\" para o da página)")
                mapa[empresa] = ""

    f = cfg["filtro_titulo"]
    f["basta_ter"] = _lista_textos(f["basta_ter"], "filtro_titulo.basta_ter", erros)
    f["recusar"] = _lista_textos(f["recusar"], "filtro_titulo.recusar", erros)
    grupos = f["ou_ter_um_de_cada_grupo"]
    if not isinstance(grupos, list) or not all(isinstance(g, list) for g in grupos):
        erros.append("filtro_titulo.ou_ter_um_de_cada_grupo: esperava uma lista de listas, como [[\"gerente\"], [\"ti\"]]")
        grupos = []
    f["ou_ter_um_de_cada_grupo"] = [g for g in (_lista_textos(g, "filtro_titulo.ou_ter_um_de_cada_grupo", erros) for g in grupos) if g]

    d = cfg["descartar_titulos"]
    d["com"] = _lista_textos(d["com"], "descartar_titulos.com", erros)
    d["comecando_com"] = _lista_textos(d["comecando_com"], "descartar_titulos.comecando_com", erros)

    loc = cfg["locais_de_interesse"]
    loc["palavras"] = _lista_textos(loc["palavras"], "locais_de_interesse.palavras", erros)
    loc["paises"] = [x.upper() for x in _lista_textos(loc["paises"], "locais_de_interesse.paises", erros)]

    a = cfg["avaliacao"]
    if a["regiao"] is not OBRIGATORIO and (not isinstance(a["regiao"], str) or not a["regiao"].strip()):
        erros.append("avaliacao.regiao: escreva a região onde você aceita trabalho híbrido ou presencial")
    if a["areas"] is not OBRIGATORIO:
        areas = a["areas"] if isinstance(a["areas"], list) else []
        if not areas:
            erros.append("avaliacao.areas: liste ao menos uma área, como {\"nome\": \"dados\", \"descricao\": \"...\"}")
        ids = []
        for i, area in enumerate(areas, 1):
            if not isinstance(area, dict) or not str(area.get("nome", "")).strip() or not str(area.get("descricao", "")).strip():
                erros.append(f"avaliacao.areas, item {i}: precisa de \"nome\" e \"descricao\"")
                continue
            area["id"] = normalizar(area["nome"]).replace(" ", "_")
            if area["id"] == "outra" or area["id"] in ids:
                erros.append(f"avaliacao.areas, item {i}: nome \"{area['nome']}\" repetido ou reservado")
            ids.append(area["id"])
    if a["pontos_area"] is not OBRIGATORIO:
        a["pontos_area"] = _lista_textos(a["pontos_area"], "avaliacao.pontos_area", erros, False)
    if not isinstance(a["pontos_senioridade"], str) or not a["pontos_senioridade"].strip():
        erros.append("avaliacao.pontos_senioridade: não pode ficar vazio")
    teto = _lista_textos(a["senioridades_com_teto"], "avaliacao.senioridades_com_teto", erros)
    for s in teto:
        if s not in SENIORIDADES:
            erros.append(f"avaliacao.senioridades_com_teto: \"{s}\" não existe (use: {', '.join(SENIORIDADES)})")
    a["senioridades_com_teto"] = [s for s in teto if s in SENIORIDADES]
    return cfg


def lista_humana(itens, e="ou"):
    itens = list(itens)
    return itens[0] if len(itens) == 1 else ", ".join(itens[:-1]) + f" {e} " + itens[-1]


def montar_prompt(modelo, cfg):
    """Preenche os campos {{...}} do prompt.md com a avaliacao do config.json."""
    a = cfg["avaliacao"]
    cats = [f"\"{x['id']}\" ({x['descricao'].strip()})" for x in a["areas"]] + ["\"outra\""]
    teto = a["senioridades_com_teto"]
    campos = {
        "categorias": lista_humana(cats),
        "regiao": a["regiao"].strip(),
        "pontos_area": "; ".join(x.rstrip(";.") for x in a["pontos_area"]),
        "pontos_senioridade": a["pontos_senioridade"].strip().rstrip("."),
        "teto_senioridade": (f"- {lista_humana(SENIORIDADES[s] for s in teto)} → score máximo 30.\n" if teto else ""),
    }
    texto = re.sub(r"<!--.*?-->\s*", "", modelo, flags=re.S)
    faltando = sorted(set(re.findall(r"\{\{(\w+)\}\}", texto)) - set(campos))
    if faltando:
        raise ErroConfig(f"prompt: campo(s) desconhecido(s) {', '.join('{{' + x + '}}' for x in faltando)} "
                         f"(os que existem: {', '.join(campos)})")
    return re.sub(r"\{\{(\w+)\}\}", lambda m: campos[m.group(1)], texto)


def prompt_curriculo(pasta=None):
    """Instruções para transformar o PDF do currículo em perfil (config/ vale no lugar do padrão)."""
    pasta = Path(pasta) if pasta else PASTA_PADRAO
    arq = pasta / "prompt_curriculo.md" if (pasta / "prompt_curriculo.md").exists() else RAIZ / "prompt_curriculo.md"
    return re.sub(r"<!--.*?-->\s*", "", arq.read_text(encoding="utf-8"), flags=re.S).strip()


def carregar(pasta=None):
    """Devolve (config, perfil, prompt, avisos). Levanta ErroConfig com tudo o que está errado."""
    pasta = Path(pasta) if pasta else PASTA_PADRAO
    arquivo = pasta / "config.json"
    if not arquivo.exists():
        raise ErroConfig(f"não achei {arquivo}.\n  Na primeira vez, copie o exemplo e edite os dois arquivos:\n"
                         f"    cp -r exemplo config\n"
                         "  (config/config.json e config/perfil.md; ficam fora do git)")
    erros, avisos = [], []
    cfg = conferir(mesclar(PADRAO, ler_json(arquivo), "", erros, avisos), erros, avisos)

    perfil_arq = pasta / "perfil.md"
    perfil = perfil_arq.read_text(encoding="utf-8").strip() if perfil_arq.exists() else ""
    if not perfil:
        erros.append(f"{perfil_arq}: falta o perfil (resumo do currículo que o Gemini usa para dar a nota)")
    elif "<!-- exemplo" in perfil:
        avisos.append("perfil.md ainda é o do exemplo: troque pelo seu")
    perfil = re.sub(r"<!--.*?-->\s*", "", perfil, flags=re.S).strip()  # comentários não vão para o Gemini
    if erros:
        raise ErroConfig("\n".join(f"- {e}" for e in erros))

    prompt_arq = pasta / "prompt.md" if (pasta / "prompt.md").exists() else RAIZ / "prompt.md"
    prompt = montar_prompt(prompt_arq.read_text(encoding="utf-8"), cfg)
    return cfg, perfil, prompt, avisos


def para_js(cfg):
    """Só o que os nós Code usam (sem os comentários "_...")."""
    def limpar(v):
        if isinstance(v, dict):
            return {k: limpar(x) for k, x in v.items() if not str(k).startswith("_")}
        if isinstance(v, list):
            return [limpar(x) for x in v]
        return v
    return limpar(cfg)


def principal(argv):
    pasta = next((a for a in argv if not a.startswith("--")), None)
    try:
        cfg, perfil, _, avisos = carregar(pasta)
    except ErroConfig as e:
        print(f"ERRO na configuração:\n{e}", file=sys.stderr)
        return 1
    if "--mostrar" in argv:
        print(json.dumps(para_js(cfg), ensure_ascii=False, indent=2))
        return 0
    for a in avisos:
        print(f"AVISO: {a}")
    ativas = [f for f in FONTES if cfg["fontes"][f]]
    t = cfg["termos_de_busca"]
    print(f"Configuração ok: {len(ativas)} fonte(s) ligada(s), {len(cfg['linkedin_buscas'])} busca(s) do LinkedIn, "
          f"{len(t['cargos'])} cargo(s) e {len(t['assuntos'])} assunto(s), "
          f"{sum(len(m) for m in cfg['paginas_de_carreira'].values())} empresa(s), perfil com {len(perfil)} caracteres.")
    return 0


if __name__ == "__main__":
    sys.exit(principal(sys.argv[1:]))
