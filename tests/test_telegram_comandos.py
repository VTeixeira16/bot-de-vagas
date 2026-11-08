#!/usr/bin/env python3
"""Testes do servidor/telegram_comandos.py (sem rede). Rodado pelo tests/test.js."""
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "servidor"))
import telegram_comandos as tc  # noqa: E402

AGORA = 1_800_000_000


def update(texto, chat=123, idade=5, tipo="private"):
    return {"update_id": 1, "message": {"message_id": 7, "date": AGORA - idade,
                                        "chat": {"id": chat, "type": tipo}, "text": texto}}


class ParaN8n(unittest.TestCase):
    def test_aceita_mensagem_do_chat(self):
        self.assertEqual(tc.para_n8n(update(" /vagas "), "123", AGORA),
                         ({"texto": "/vagas", "data": AGORA - 5, "message_id": 7}, None))

    def test_ignora_outro_chat_antiga_e_sem_texto(self):
        dados, motivo = tc.para_n8n(update("/buscar", chat=999), "123", AGORA)
        self.assertIsNone(dados)
        self.assertIn("outro chat (999)", motivo)
        self.assertIn("antiga", tc.para_n8n(update("/buscar", idade=3600), "123", AGORA)[1])
        self.assertIsNone(tc.para_n8n(update(""), "123", AGORA)[0])
        self.assertIsNone(tc.para_n8n({"update_id": 2, "edited_message": {}}, "123", AGORA)[0])

    def test_ignora_grupo_mesmo_com_o_chat_id_configurado(self):
        for tipo in ("group", "supergroup", "channel", None):
            dados, motivo = tc.para_n8n(update("/usar", chat=-100123, tipo=tipo), "-100123", AGORA)
            self.assertIsNone(dados)
            self.assertIn("conversa privada", motivo)


def documento(nome="curriculo.pdf", mime="application/pdf", tamanho=1000, legenda=None):
    msg = {"message_id": 8, "date": AGORA - 5, "chat": {"id": 123, "type": "private"},
           "document": {"file_id": "F1", "file_name": nome, "mime_type": mime, "file_size": tamanho}}
    if legenda:
        msg["caption"] = legenda
    return {"update_id": 2, "message": msg}


class Curriculo(unittest.TestCase):
    def test_pdf_vira_comando_curriculo_com_legenda(self):
        dados, motivo = tc.para_n8n(documento(legenda=" só remoto "), "123", AGORA)
        self.assertIsNone(motivo)
        self.assertEqual(dados["texto"], "/curriculo")
        self.assertEqual(dados["legenda"], "só remoto")
        self.assertEqual(dados["arquivo"], {"file_id": "F1", "nome": "curriculo.pdf"})

    def test_recusa_outro_formato_e_pdf_grande_com_resposta(self):
        docx = tc.para_n8n(documento("cv.docx", mime="application/msword"), "123", AGORA)[0]
        self.assertIn("só leio currículo em PDF", docx["responder"])
        grande = tc.para_n8n(documento(tamanho=tc.MAX_PDF + 1), "123", AGORA)[0]
        self.assertIn("mais de 5 MB", grande["responder"])
        self.assertIsNone(tc.para_n8n(documento(), "999", AGORA)[0])  # outro chat continua ignorado

    def test_baixa_pdf_em_base64(self):
        bot = tc.Bot("TOKEN-SECRETO", "123")
        resp = mock.MagicMock()
        resp.__enter__.return_value.read.return_value = b"%PDF-1.7 conteudo"
        with mock.patch.object(bot, "api", return_value={"result": {"file_path": "documents/x.pdf"}}), \
                mock.patch.object(tc.urllib.request, "urlopen", return_value=resp) as abrir, \
                mock.patch.object(tc, "log"):
            dados = {"texto": "/curriculo", "arquivo": {"file_id": "F1", "nome": "cv.pdf"}}
            self.assertTrue(bot.preparar(dados))
        self.assertEqual(abrir.call_args[0][0], "https://api.telegram.org/file/botTOKEN-SECRETO/documents/x.pdf")
        self.assertEqual(dados["arquivo"], {"nome": "cv.pdf", "base64": "JVBERi0xLjcgY29udGV1ZG8="})

    def test_arquivo_que_nao_e_pdf_avisa_e_nao_entrega(self):
        bot = tc.Bot("TOKEN-SECRETO", "123")
        resp = mock.MagicMock()
        resp.__enter__.return_value.read.return_value = b"PK\x03\x04 zip"
        with mock.patch.object(bot, "api", return_value={"result": {"file_path": "d/x.pdf"}}), \
                mock.patch.object(tc.urllib.request, "urlopen", return_value=resp), \
                mock.patch.object(bot, "avisar") as avisar, mock.patch.object(tc, "log") as log:
            self.assertFalse(bot.preparar({"texto": "/curriculo", "arquivo": {"file_id": "F1", "nome": "cv.pdf"}}))
        self.assertIn("não é um PDF", avisar.call_args[0][0])
        self.assertNotIn("TOKEN-SECRETO", str(log.call_args_list))


class Entregar(unittest.TestCase):
    def test_avisa_quando_workflow_despublicado(self):
        bot = tc.Bot("TOKEN-SECRETO", "123")
        erro = urllib.error.HTTPError(tc.WEBHOOK, 404, "Not Found", {}, None)
        with mock.patch.object(tc, "post", side_effect=erro) as post, \
                mock.patch.object(bot, "avisar") as avisar, \
                mock.patch.object(tc.time, "sleep"), mock.patch.object(tc, "log"):
            bot.entregar({"texto": "/vagas"})
        self.assertEqual(post.call_count, 1)  # 404 não adianta repetir
        self.assertIn("não está publicado", avisar.call_args[0][0])

    def test_repete_enquanto_n8n_reinicia(self):
        bot = tc.Bot("TOKEN-SECRETO", "123")
        efeitos = [urllib.error.URLError("refused")] * 2 + [None]
        with mock.patch.object(tc, "post", side_effect=efeitos) as post, \
                mock.patch.object(bot, "avisar") as avisar, \
                mock.patch.object(tc.time, "sleep"), mock.patch.object(tc, "log"):
            bot.entregar({"texto": "/buscar"})
        self.assertEqual(post.call_count, 3)
        avisar.assert_not_called()

    def test_manda_o_segredo_no_cabecalho(self):
        bot = tc.Bot("TOKEN-SECRETO", "123", "s3gr3do")
        with mock.patch.object(tc, "post") as post, mock.patch.object(tc, "log"):
            bot.entregar({"texto": "/vagas"})
        self.assertEqual(post.call_args.kwargs["extra"], {tc.CABECALHO_SEGREDO: "s3gr3do"})

    def test_segredo_recusado_avisa_e_nao_repete(self):
        bot = tc.Bot("TOKEN-SECRETO", "123", "errado")
        erro = urllib.error.HTTPError(tc.WEBHOOK, 403, "Forbidden", {}, None)
        with mock.patch.object(tc, "post", side_effect=erro) as post, \
                mock.patch.object(bot, "avisar") as avisar, \
                mock.patch.object(tc.time, "sleep"), mock.patch.object(tc, "log"):
            bot.entregar({"texto": "/vagas"})
        self.assertEqual(post.call_count, 1)
        self.assertIn("recusou o segredo", avisar.call_args[0][0])

    def test_erro_nao_mostra_token(self):
        erro = urllib.error.HTTPError("https://api.telegram.org/botTOKEN-SECRETO/getUpdates", 401, "x", {}, None)
        self.assertEqual(tc.descrever(erro), "HTTP 401")


if __name__ == "__main__":
    unittest.main(verbosity=0)
