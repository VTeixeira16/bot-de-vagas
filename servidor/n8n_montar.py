#!/usr/bin/env python3
"""Monta o JSON que o servidor/configurar_n8n.sh importa no n8n (saída na tela).

  python3 servidor/n8n_montar.py credenciais   -> credenciais (segredos lidos do ambiente)
  python3 servidor/n8n_montar.py workflow [arquivo] -> workflow.json (gerado pelo build.py)
                                                  ligado às credenciais e com o ritmo do
                                                  Gemini do GEMINI_FATURAMENTO
  python3 servidor/n8n_montar.py id            -> ID fixo do workflow
  python3 servidor/n8n_montar.py id-credencial <tipo> -> ID fixo da credencial

Os IDs são fixos para que importar de novo atualize em vez de duplicar. Credencial cujo
segredo está vazio não é gerada (o n8n mantém a que já existe).
"""
import json
import os
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
WORKFLOW_ID = "BotVagasWorkflow"

CRED = {
    "postgres": {"id": "VagasPostgres001", "name": "Postgres (vagas)"},
    "httpHeaderAuth": {"id": "VagasGemini00001", "name": "Gemini (x-goog-api-key)"},
    "telegramApi": {"id": "VagasTelegram001", "name": "Telegram (bot de vagas)"},
    # Segredo que o container telegram manda ao webhook de comandos (N8N_COMANDO_SEGREDO)
    "comando": {"id": "VagasComando0001", "name": "Comando (X-Bot-Vagas-Segredo)"},
}
CABECALHO_COMANDO = "X-Bot-Vagas-Segredo"

# Ritmo do nó do Gemini com faturamento ativo (GEMINI_FATURAMENTO=sim no .env): 5 pedidos
# de uma vez, um lote por segundo (até ~300 por minuto, abaixo do limite do nível pago).
# Sem faturamento fica o do workflow.json: 1 a cada 6 s (plano gratuito, ~10 por minuto).
RITMO_FATURAMENTO = {"batchSize": 5, "batchInterval": 1000}


def com_faturamento(amb):
    return str(amb.get("GEMINI_FATURAMENTO", "")).strip().lower() in ("sim", "1", "true", "yes")


# Tipo de nó -> credencial que ele usa
POR_TIPO = {
    "n8n-nodes-base.postgres": "postgres",
    "n8n-nodes-base.telegram": "telegramApi",
}


def credenciais(amb):
    saida = []
    if amb.get("POSTGRES_PASSWORD"):
        saida.append({**CRED["postgres"], "type": "postgres", "data": {
            "host": "postgres", "database": "vagas", "user": "vagas",
            "password": amb["POSTGRES_PASSWORD"], "port": 5432, "ssl": "disable",
            "allowUnauthorizedCerts": False, "maxConnections": 100,
        }})
    if amb.get("GEMINI_KEY"):
        saida.append({**CRED["httpHeaderAuth"], "type": "httpHeaderAuth",
                      "data": {"name": "x-goog-api-key", "value": amb["GEMINI_KEY"]}})
    if amb.get("TELEGRAM_TOKEN"):
        saida.append({**CRED["telegramApi"], "type": "telegramApi", "data": {
            "accessToken": amb["TELEGRAM_TOKEN"], "baseUrl": "https://api.telegram.org"}})
    if amb.get("N8N_COMANDO_SEGREDO"):
        saida.append({**CRED["comando"], "type": "httpHeaderAuth",
                      "data": {"name": CABECALHO_COMANDO, "value": amb["N8N_COMANDO_SEGREDO"]}})
    return saida


def workflow(amb, arquivo=None):
    wf = json.loads(Path(arquivo or RAIZ / "workflow.json").read_text(encoding="utf-8"))
    wf["id"] = WORKFLOW_ID
    for no in wf["nodes"]:
        tipo = no["type"]
        params = no.get("parameters", {})
        cred = POR_TIPO.get(tipo)
        if tipo == "n8n-nodes-base.httpRequest" and params.get("genericAuthType") == "httpHeaderAuth":
            cred = "httpHeaderAuth"
        if cred:
            no["credentials"] = {cred: dict(CRED[cred])}
        if tipo == "n8n-nodes-base.webhook" and params.get("authentication") == "headerAuth":
            no["credentials"] = {"httpHeaderAuth": dict(CRED["comando"])}
        if tipo == "n8n-nodes-base.executeWorkflow":  # o /buscar chama este mesmo workflow
            params["workflowId"]["value"] = WORKFLOW_ID
        if tipo == "n8n-nodes-base.telegram" and amb.get("TELEGRAM_CHAT_ID"):
            params["chatId"] = amb["TELEGRAM_CHAT_ID"]
        if cred == "httpHeaderAuth" and com_faturamento(amb):
            params["options"]["batching"]["batch"] = dict(RITMO_FATURAMENTO)
    return wf


if __name__ == "__main__":
    modo = sys.argv[1] if len(sys.argv) > 1 else ""
    if modo == "credenciais":
        print(json.dumps(credenciais(os.environ), ensure_ascii=False))
    elif modo == "id":
        print(WORKFLOW_ID)
    elif modo == "id-credencial" and len(sys.argv) > 2 and sys.argv[2] in CRED:
        print(CRED[sys.argv[2]]["id"])
    elif modo == "workflow":
        print(json.dumps(workflow(os.environ, sys.argv[2] if len(sys.argv) > 2 else None), ensure_ascii=False))
    else:
        sys.exit(__doc__)
