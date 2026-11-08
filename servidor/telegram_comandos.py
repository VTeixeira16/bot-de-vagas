#!/usr/bin/env python3
"""Recebe os comandos do Telegram (/vagas, /buscar, ...) e repassa ao n8n.

Roda no container `telegram` do docker-compose. O n8n só recebe mensagens do Telegram por
webhook, que exige um endereço público, e aqui nada fica exposto na internet. Então este
programa pergunta ao Telegram por mensagens novas (getUpdates com long polling: só conexão
de saída) e entrega cada uma ao webhook interno do n8n, que interpreta o comando e responde
no Telegram.

- Só aceita mensagens do seu chat (TELEGRAM_CHAT_ID); as de outras pessoas são ignoradas.
- Ignora mensagens antigas (mais de 15 min), por exemplo as mandadas com o servidor
  desligado: assim um /buscar esquecido não dispara horas depois.
- Se o n8n não responder (reiniciando, workflow despublicado), avisa no Telegram daqui.
- PDF mandado no chat (o currículo) vira o comando /curriculo: o arquivo é baixado do
  Telegram e vai junto, em base64, para o n8n montar o perfil novo com o Gemini.

Só biblioteca padrão do Python. O token vem do .env (TELEGRAM_TOKEN) e nunca vai para o log.
"""
import base64
import json
import os
import time
import urllib.error
import urllib.request

API = "https://api.telegram.org/bot{token}/{metodo}"
ARQUIVO = "https://api.telegram.org/file/bot{token}/{caminho}"
MAX_PDF = 5 * 1024 * 1024    # bytes; o n8n aceita até 16 MB por pedido (o base64 cresce 1/3)
WEBHOOK = os.environ.get("N8N_WEBHOOK", "http://n8n:5678/webhook/bot-vagas-comando")
# Segredo que o webhook do n8n exige no cabeçalho (gerado pelo configurar_n8n.sh no .env)
CABECALHO_SEGREDO = "X-Bot-Vagas-Segredo"
MAX_IDADE = 15 * 60          # segundos
TENTATIVAS_N8N = 6           # o n8n leva ~30 s para subir depois de um restart
PAUSA_N8N = 10

# Menu que aparece no Telegram ao digitar "/"
COMANDOS = [
    ("vagas", "Resumo agora das vagas já analisadas e ainda não enviadas"),
    ("buscar", "Coleta, analisa e resume (/buscar 30 = 30 dias; /buscar gupy = só a Gupy)"),
    ("recentes", "Repete as melhores dos últimos dias (ex.: /recentes 3)"),
    ("status", "Situação do bot e do banco"),
    ("perfil", "Resumo do perfil usado nas notas (/perfil completo = texto inteiro)"),
    ("curriculo", "Como trocar o perfil mandando o PDF do currículo"),
    ("usar", "Passa a usar o perfil montado do último currículo"),
    ("ajuda", "Lista de comandos"),
]


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def descrever(erro):
    """Erro sem URL (a URL do Telegram contém o token)."""
    if isinstance(erro, urllib.error.HTTPError):
        return f"HTTP {erro.code}"
    if isinstance(erro, urllib.error.URLError):
        return f"sem conexão ({erro.reason})"
    return type(erro).__name__


def post(url, dados, timeout, extra=None):
    req = urllib.request.Request(url, data=json.dumps(dados).encode("utf-8"),
                                 headers={"Content-Type": "application/json", **(extra or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        corpo = resp.read().decode("utf-8")
    try:
        return json.loads(corpo) if corpo else None
    except ValueError:
        return None


def para_n8n(update, chat_id, agora):
    """(dados a entregar ao n8n, motivo para ignorar): um dos dois é None."""
    msg = update.get("message") or {}
    dados_chat = msg.get("chat") or {}
    chat = str(dados_chat.get("id"))
    if chat != str(chat_id).strip():
        return None, f"mensagem de outro chat ({chat}) ignorada; o TELEGRAM_CHAT_ID do .env não confere?"
    # Só a conversa privada com o bot: num grupo, qualquer membro mandaria comandos (até
    # trocar o perfil com um PDF + /usar)
    if dados_chat.get("type") != "private":
        return None, (f"mensagem de {dados_chat.get('type') or 'chat sem tipo'} ignorada; os comandos "
                      "valem só na conversa privada (o TELEGRAM_CHAT_ID tem de ser o seu, não o de um grupo)")
    idade = agora - int(msg.get("date") or 0)
    if idade > MAX_IDADE:
        return None, f"mensagem antiga ignorada ({int(idade // 60)} min)"
    base = {"data": msg.get("date"), "message_id": msg.get("message_id")}
    doc = msg.get("document")
    if doc:
        nome = str(doc.get("file_name") or "arquivo")[:120]
        if doc.get("mime_type") != "application/pdf" and not nome.lower().endswith(".pdf"):
            return {**base, "responder": f"📎 Recebi \"{nome}\", mas só leio currículo em PDF. "
                                          "Salve o currículo como PDF e mande de novo."}, None
        if int(doc.get("file_size") or 0) > MAX_PDF:
            return {**base, "responder": f"📎 \"{nome}\" tem mais de {MAX_PDF // 1024 // 1024} MB. "
                                          "Mande uma versão menor do PDF (sem imagens grandes)."}, None
        return {**base, "texto": "/curriculo", "legenda": (msg.get("caption") or "").strip()[:500],
                "arquivo": {"file_id": doc.get("file_id"), "nome": nome}}, None
    texto = (msg.get("text") or "").strip()
    if not texto:
        return None, "mensagem sem texto ignorada"
    return {**base, "texto": texto[:200]}, None


class Bot:
    def __init__(self, token, chat_id, segredo=""):
        self.token, self.chat_id, self.segredo = token, chat_id, segredo

    def api(self, metodo, dados, timeout=30):
        return post(API.format(token=self.token, metodo=metodo), dados, timeout)

    def avisar(self, texto):
        try:
            self.api("sendMessage", {"chat_id": self.chat_id, "text": texto})
        except Exception as e:  # noqa: BLE001 — o aviso é o último recurso
            log(f"sendMessage falhou: {descrever(e)}")

    def baixar_pdf(self, file_id):
        """Conteúdo do arquivo mandado no chat, em base64 (bots baixam até 20 MB)."""
        info = (self.api("getFile", {"file_id": file_id}) or {}).get("result") or {}
        if not info.get("file_path"):
            raise ValueError("o Telegram não devolveu o arquivo")
        url = ARQUIVO.format(token=self.token, caminho=info["file_path"])
        with urllib.request.urlopen(url, timeout=60) as resp:
            conteudo = resp.read(MAX_PDF + 1)
        if len(conteudo) > MAX_PDF:
            raise ValueError("arquivo grande demais")
        if not conteudo.startswith(b"%PDF"):
            raise ValueError("o arquivo não é um PDF")
        return base64.b64encode(conteudo).decode("ascii")

    def preparar(self, dados):
        """Baixa o PDF, quando houver. Devolve False (e avisa no chat) se não der."""
        arquivo = dados.get("arquivo")
        if not arquivo:
            return True
        try:
            arquivo["base64"] = self.baixar_pdf(arquivo.pop("file_id"))
        except Exception as e:  # noqa: BLE001
            motivo = str(e) if isinstance(e, ValueError) else descrever(e)
            log(f"não consegui baixar o PDF {arquivo.get('nome')!r}: {motivo}")
            self.avisar(f"⚠️ Não consegui baixar \"{arquivo.get('nome')}\" do Telegram ({motivo}). Mande de novo.")
            return False
        log(f"PDF baixado: {arquivo.get('nome')!r}, {len(arquivo['base64']) * 3 // 4 // 1024} KB")
        return True

    def entregar(self, dados):
        ultimo = None
        for tentativa in range(TENTATIVAS_N8N):
            try:
                post(WEBHOOK, dados, timeout=60, extra={CABECALHO_SEGREDO: self.segredo})
                log(f"comando entregue ao n8n: {dados['texto'][:40]!r}")
                return
            except urllib.error.HTTPError as e:
                ultimo = e
                if e.code in (401, 403, 404):  # sem segredo certo, ou workflow despublicado
                    break
            except Exception as e:  # noqa: BLE001
                ultimo = e
            if tentativa < TENTATIVAS_N8N - 1:
                time.sleep(PAUSA_N8N)
        log(f"n8n não recebeu o comando: {descrever(ultimo)}")
        codigo = ultimo.code if isinstance(ultimo, urllib.error.HTTPError) else None
        if codigo == 404:
            dica = "o workflow não está publicado (rode bash servidor/configurar_n8n.sh)"
        elif codigo in (401, 403):
            dica = "o n8n recusou o segredo dos comandos (rode bash servidor/configurar_n8n.sh)"
        else:
            dica = "o n8n está fora do ar ou reiniciando (docker compose ps)"
        self.avisar(f"⚠️ Recebi \"{dados['texto'][:60]}\", mas não consegui passar ao n8n: "
                    f"{dica}. Tente de novo em instantes.")

    def rodar(self):
        try:
            self.api("setMyCommands", {"commands": [
                {"command": c, "description": d} for c, d in COMANDOS]})
        except Exception as e:  # noqa: BLE001
            log(f"setMyCommands falhou: {descrever(e)}")
        log(f"ouvindo comandos do Telegram (chat {self.chat_id}, n8n em {WEBHOOK})")
        offset = None
        while True:
            pedido = {"timeout": 50, "allowed_updates": ["message"]}
            if offset is not None:
                pedido["offset"] = offset
            try:
                resp = self.api("getUpdates", pedido, timeout=70) or {}
            except urllib.error.HTTPError as e:
                # 401: token errado; 409: outro programa lendo o mesmo bot
                log(f"getUpdates falhou: {descrever(e)}")
                time.sleep(300 if e.code == 401 else 30)
                continue
            except Exception as e:  # noqa: BLE001
                log(f"getUpdates falhou: {descrever(e)}")
                time.sleep(15)
                continue
            for update in resp.get("result", []):
                offset = update["update_id"] + 1
                dados, motivo = para_n8n(update, self.chat_id, time.time())
                if not dados:
                    log(motivo)
                elif dados.get("responder"):
                    log(f"arquivo recusado: {dados['responder'][:80]!r}")
                    self.avisar(dados["responder"])
                else:
                    log(f"comando recebido: {dados['texto'][:40]!r}")
                    if self.preparar(dados):
                        self.entregar(dados)


def main():
    token = os.environ.get("TELEGRAM_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    segredo = os.environ.get("N8N_COMANDO_SEGREDO", "").strip()
    if not token or not chat_id:
        log("TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID vazio no .env: rode bash servidor/configurar_n8n.sh")
        while True:  # sem sair: com restart: always, sair viraria um loop de reinícios
            time.sleep(3600)
    if not segredo:
        log("N8N_COMANDO_SEGREDO vazio no .env: o n8n vai recusar os comandos; rode bash servidor/configurar_n8n.sh")
    Bot(token, chat_id, segredo).rodar()


if __name__ == "__main__":
    main()
