// Nó "Gupy: buscar" — consulta o portal público de vagas da Gupy (sem login), um termo
// (e página) por vez, com pausa entre as chamadas. A Gupy já trocou o endereço da API
// (portal.api.gupy.io e depois employability-portal.gupy.io passaram a responder 404; desde
// 10/2026 o portal usa portal.gupy.io/api/job-search/jobs, com os mesmos parâmetros e o
// mesmo { data, pagination }): tenta os endereços abaixo em ordem e fica com o primeiro
// que responder. Devolve um item por resposta ({ termo, data: [...] }).
const GUPY_APIS = [
  'https://portal.gupy.io/api/job-search/jobs',
  'https://employability-portal.gupy.io/api/v1/jobs',
];
const PAUSA_MS = 1500;

async function main(items, helpers) {
  const saida = [];
  const erros = [];
  let api = null;
  let primeira = true;
  for (const item of items) {
    const termo = item.json.termo;
    const offset = item.json.offset || 0;
    const qs = `jobName=${encodeURIComponent(termo)}&limit=100&offset=${offset}`;
    for (const base of (api ? [api] : GUPY_APIS)) {
      if (!primeira) await new Promise(r => setTimeout(r, PAUSA_MS));
      primeira = false;
      try {
        let resp = await helpers.httpRequest({
          method: 'GET',
          url: `${base}?${qs}`,
          headers: { 'User-Agent': UA_NAVEGADOR, Accept: 'application/json' },
          json: true,
          timeout: 30000,
        });
        if (typeof resp === 'string') resp = JSON.parse(resp);
        if (resp && Array.isArray(resp.data)) {
          api = base;
          saida.push({ json: { termo, offset, data: resp.data } });
          break;
        }
        erros.push(`${base}: resposta sem lista de vagas`);
      } catch (e) {
        erros.push(`${base}: ${String(e.message || e).slice(0, 120)}`);
      }
    }
  }
  console.log(`Gupy: ${saida.length} resposta(s) de ${items.length} consulta(s), API ${api || 'nenhuma'}`);
  if (!saida.length && erros.length) saida.push({ json: { aviso: `Gupy: nenhuma resposta válida: ${erros.slice(0, 3).join(' | ')}` } });
  return saida;
}
