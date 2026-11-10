// Nó "Gupy: termos de busca" — um item por termo pesquisado no portal da Gupy: os cargos e
// os assuntos de termos_de_busca no config.json. Cada termo é uma chamada (com 1,5 s de
// pausa entre elas).
const TERMOS = [...new Set([...CONFIG.termos_de_busca.cargos, ...CONFIG.termos_de_busca.assuntos])];

// Cada página traz até 100 vagas; na coleta retroativa lê 3 páginas por termo.
const PAGINAS_RETRO = 3;

function main(retroativo = false) {
  const paginas = retroativo ? PAGINAS_RETRO : 1;
  const itens = [];
  for (const termo of TERMOS) {
    for (let i = 0; i < paginas; i++) itens.push({ json: { termo, offset: i * 100 } });
  }
  return itens;
}
