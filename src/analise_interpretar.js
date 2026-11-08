// Nó "Análise: interpretar" — lê a resposta do Gemini e monta o registro para o banco.
// Cada item vem do "Análise: conferir resposta": a vaga, a "resposta" do Gemini e o
// "erro_gemini" (null quando deu certo).
// O que o modelo escreve vai para o banco e para o Telegram: sem link (a vaga pode tentar
// pôr um link de golpe no resumo) e com tamanho limitado.
// Domínio sem "http" também vira link no Telegram; ficam de fora .net, .org e .io para não
// apagar nomes de tecnologia (ASP.NET, socket.io).
const RE_LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com\.br|com|xyz|info|app|link|ly|me)\b(?:\/\S*)?|\b[a-z0-9-]+\.[a-z]{2,}\/\S+/gi;
function limpo(t, max) {
  return cortar(String(t || '').replace(RE_LINK, '[link removido]').replace(/\s+/g, ' ').trim(), max);
}
function itens(x, max) {
  return (Array.isArray(x) ? x : []).slice(0, 4).map(i => limpo(i, max)).filter(Boolean);
}

function main(items) {
  return items.map(item => {
    const v = item.json;
    const base = { fonte: v.fonte, id_externo: v.id_externo };
    let a = null;
    try { a = JSON.parse(textoResposta(v.resposta) || 'null'); } catch (e) { a = null; }
    if (!a || typeof a.score !== 'number') {
      const e = v.erro_gemini;
      const erro = e ? `${e.codigo || ''} ${e.detalhe}`.trim() : 'resposta inválida';
      // Cobrança, chave, cota ou sobrecarga não são culpa da vaga: volta para a fila
      // (pendente não tem limite de tentativas) e entra na próxima análise.
      const status = e && ERROS_DE_SERVICO.includes(e.tipo) ? 'pendente' : 'erro_llm';
      return { json: { registro: { ...base, status, titulo: v.titulo, empresa: v.empresa, local: v.local, texto: v.texto, score: null,
        analise: { erro, tipo_erro: e ? e.tipo : 'resposta', modelo: v.modelo } } } };
    }
    // Reaplica os tetos do prompt por garantia (o modelo às vezes esquece).
    let score = Math.max(0, Math.min(100, Math.round(a.score)));
    if (a.local_compativel === false) score = Math.min(score, 40);
    if (CONFIG.avaliacao.senioridades_com_teto.includes(a.senioridade)) score = Math.min(score, 30);
    if (a.categoria === 'outra') score = Math.min(score, 45);
    // Título, empresa e local: os da fonte valem mais que os do modelo (o texto da vaga pode
    // tentar trocar o nome da empresa); o do modelo só preenche o que a fonte não trouxe.
    const analise = {
      ...a,
      titulo: limpo(a.titulo, 200), empresa: limpo(a.empresa, 120), local: limpo(a.local, 120),
      resumo: limpo(a.resumo, 300), atende: itens(a.atende, 160), gaps: itens(a.gaps, 160),
      score, modelo: v.modelo,
    };
    return {
      json: {
        registro: {
          ...base,
          status: 'analisada',
          titulo: v.titulo || analise.titulo,
          empresa: v.empresa || analise.empresa,
          local: v.local || analise.local,
          texto: v.texto,
          score,
          analise,
        },
      },
    };
  });
}
