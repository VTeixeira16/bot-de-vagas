// Nó "Análise: avisar problema no Gemini" — uma mensagem no Telegram quando o Gemini
// recusar pedidos da análise por cobrança, chave, cota ou sobrecarga (depois de tentar os
// modelos de reserva). Sem problema, não manda nada.
function main(items) {
  const erros = items.map(i => i.json).filter(v => v && !v.refazer && v.erro_gemini && ERROS_DE_SERVICO.includes(v.erro_gemini.tipo));
  if (!erros.length) return [];
  const porTipo = new Map();
  for (const v of erros) porTipo.set(v.erro_gemini.tipo, v.erro_gemini);
  const linhas = [`⚠️ <b>O Gemini recusou ${erros.length} vaga(s) da análise</b>; elas continuam na fila para a próxima análise.`];
  for (const [tipo, e] of porTipo) {
    linhas.push(`\n<b>${e.codigo || 'erro'}</b> (${escErro(e.detalhe)})\n${ORIENTACAO[tipo]}`);
  }
  return [{ json: { texto: linhas.join('\n') } }];
}
