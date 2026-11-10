// Nó "Sites e carreiras: buscar" — roda ao mesmo tempo as fontes novas: os sites
// brasileiros (src/sites_buscar.js) e as páginas de carreira (src/carreiras_buscar.js).
// O n8n executa os ramos do workflow um depois do outro; juntando aqui, cada site segue
// com a própria pausa entre os pedidos, mas os sites não esperam uns pelos outros.
// `fontes` é 'todas' (as ligadas em fontes, no config.json) ou nomes separados por espaço
// (o /buscar gupy catho ...).
const FONTES_NOVAS = ['infojobs', 'catho', 'vagas.com', 'remotar', 'trampos', 'greenhouse', 'lever', 'workable'];

async function main(helpers, fontes, retroativo = false) {
  const pedidas = String(fontes || 'todas').split(' ');
  const lista = FONTES_NOVAS.filter(f => CONFIG.fontes[f] && (pedidas.includes('todas') || pedidas.includes(f)));
  const inicio = Date.now();
  const resultados = await Promise.all(lista.map(f => (SITES[f] ? buscarSite : buscarCarreira)(helpers, f, retroativo)));
  console.log(`Sites e carreiras: ${lista.length} fonte(s) em ${Math.round((Date.now() - inicio) / 1000)} s`);
  return resultados.flat();
}
