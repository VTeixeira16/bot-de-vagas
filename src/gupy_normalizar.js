// Nó "Gupy: normalizar" — junta as respostas do portal da Gupy (uma por termo),
// remove duplicadas, antigas e descartáveis, e devolve no formato da tabela vagas.
function main(items, retroativo = false, dias = DIAS_RETROATIVO) {
  const janela = retroativo ? dias : DIAS_RECENTES;
  const saida = new Map();
  for (const item of items) {
    const lista = (item.json && Array.isArray(item.json.data)) ? item.json.data : [];
    for (const v of lista) {
      if (!v || !v.id) continue;
      const id = String(v.id);
      if (saida.has(id)) continue;
      const titulo = v.name || '';
      if (tituloDescartavel(titulo)) continue;
      const publicado = v.publishedDate || v.publishedAt || null;
      if (!recente(publicado, janela)) continue;
      const modelo = v.workplaceType || (v.isRemoteWork ? 'remote' : '');
      const local = [v.city, v.state, modelo].filter(Boolean).join(' · ');
      const empresa = v.careerPageName || v.companyName || '';
      const descricao = htmlParaTexto(v.description || '');
      saida.set(id, {
        fonte: 'gupy',
        id_externo: id,
        link: v.jobUrl || v.url || `https://portal.gupy.io/job/${id}`,
        titulo,
        empresa,
        local,
        texto: cortar([
          `Título: ${titulo}`, `Empresa: ${empresa}`, `Local/modelo: ${local}`,
          descricao ? `Descrição:\n${descricao}` : '',
        ].filter(Boolean).join('\n'), 12000),
        publicado_em: publicado,
      });
    }
  }
  return [...saida.values()].map(json => ({ json }));
}
