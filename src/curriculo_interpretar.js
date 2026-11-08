// Nó "Currículo: interpretar" — lê a resposta do Gemini (que vem do "Currículo: conferir
// resposta", junto com o pedido). Com perfil: segue para o banco como rascunho (só vale
// depois do /usar). Sem: devolve o texto do erro para o Telegram, dizendo o que fazer.
function main(item) {
  const v = item || {};
  let r = null;
  try { r = JSON.parse(textoResposta(v.resposta) || 'null'); } catch (e) { r = null; }
  const origem = v.origem || 'curriculo.pdf';
  if (!r || r.e_curriculo === false || !String(r.perfil || '').trim()) {
    const e = v.erro_gemini;
    let motivo;
    if (r && r.e_curriculo === false) {
      motivo = 'o arquivo não parece um currículo (ou não deu para ler o texto dele; PDF escaneado como imagem às vezes falha).';
    } else if (e) {
      motivo = `o Gemini recusou (${e.codigo || 'erro'}: ${escErro(e.detalhe)}).\n${ORIENTACAO[e.tipo]}`;
    } else {
      motivo = 'o Gemini não devolveu um perfil. Tente de novo.';
    }
    return [{ json: { ok: false, origem, texto: `⚠️ Não consegui montar o perfil a partir de "${escErro(origem)}": ${motivo}\nO perfil em uso continua o mesmo.` } }];
  }
  return [{ json: { ok: true, origem, modelo: v.modelo, perfil: cortar(String(r.perfil).trim(), 12000), avisos: (r.avisos || []).slice(0, 5) } }];
}
