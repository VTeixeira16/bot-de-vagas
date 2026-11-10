// Nó "... conferir resposta" — junta cada resposta do Gemini ao pedido dela (mesma ordem:
// o nó HTTP devolve um item por pedido) e decide: deu certo ou o erro não tem conserto com
// outro modelo -> segue (refazer = false, com "resposta" e "erro_gemini"); cota ou sobrecarga
// e ainda há modelo de reserva -> volta para o "... tentativa" (refazer = true).
function main(respostas, pedidos) {
  return respostas.map((r, i) => {
    const p = (pedidos[i] && pedidos[i].json) || {};
    const erro = erroGemini(r.json);
    const t = Number(p._tentativa || 0);
    if (erro && RETENTAVEIS.includes(erro.codigo) && t + 1 < MODELOS.length) {
      console.log(`Gemini ${p.modelo}: ${erro.codigo}; tentando ${MODELOS[t + 1]}`);
      return { json: { ...p, _tentativa: t + 1, refazer: true } };
    }
    // O pedido (às vezes com um PDF) só segue se ainda puder ser refeito mais tarde
    // (o currículo tenta de novo em alguns minutos: "Currículo: tentar mais tarde?")
    const { llm_body, ...meta } = p;
    const guardar = erro && RETENTAVEIS.includes(erro.codigo) ? { llm_body } : {};
    return { json: { ...meta, ...guardar, refazer: false, resposta: r.json, erro_gemini: erro } };
  });
}
