// Filtro de título de todas as fontes (linkedin_buscar.js, gupy_normalizar.js,
// remotive_normalizar.js, sites_buscar.js e carreiras_buscar.js), pelo filtro_titulo do
// config.json: passa o título que tiver um termo de basta_ter, ou um termo de cada grupo de
// ou_ter_um_de_cada_grupo, e nenhum de recusar. Sem nenhum termo, passa tudo (menos os
// descartados). Cada vaga que passa custa uma chamada ao Gemini. O build.py junta este
// arquivo aos nós que o usam.
function tituloDeInteresse(titulo) {
  const t = String(titulo || '');
  const f = CONFIG.filtro_titulo;
  if (!t || tituloDescartavel(t)) return false;
  if (temTermo(t, f.recusar)) return false;
  const grupos = f.ou_ter_um_de_cada_grupo;
  if (!f.basta_ter.length && !grupos.length) return true;
  return temTermo(t, f.basta_ter) || (grupos.length > 0 && grupos.every(g => temTermo(t, g)));
}
