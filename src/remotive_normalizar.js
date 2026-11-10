// Nó "Remotive: normalizar" — vagas remotas internacionais da API pública do Remotive
// (categoria em termos_de_busca.remotive_categoria). Pré-filtra pelo título
// (tituloDeInteresse, filtro_titulo do config.json) para só mandar ao LLM o que pode interessar.

function main(items, retroativo = false, dias = DIAS_RETROATIVO) {
  const janela = retroativo ? dias : DIAS_RECENTES;
  const saida = new Map();
  for (const item of items) {
    const lista = (item.json && Array.isArray(item.json.jobs)) ? item.json.jobs : [];
    for (const v of lista) {
      if (!v || !v.id) continue;
      const id = String(v.id);
      const titulo = v.title || '';
      if (saida.has(id) || !tituloDeInteresse(titulo)) continue;
      if (!recente(v.publication_date, janela)) continue;
      const local = `Remoto · ${v.candidate_required_location || 'não informado'}`;
      const descricao = htmlParaTexto(v.description || '');
      saida.set(id, {
        fonte: 'remotive',
        id_externo: id,
        link: v.url,
        titulo,
        empresa: v.company_name || '',
        local,
        texto: cortar([
          `Título: ${titulo}`, `Empresa: ${v.company_name || ''}`,
          `Local exigido do candidato: ${v.candidate_required_location || 'não informado'}`,
          v.salary ? `Salário: ${v.salary}` : '',
          `Descrição:\n${descricao}`,
        ].filter(Boolean).join('\n'), 12000),
        publicado_em: v.publication_date || null,
      });
    }
  }
  return [...saida.values()].map(json => ({ json }));
}
