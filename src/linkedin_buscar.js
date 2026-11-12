// Nó "LinkedIn: buscar" — roda as suas buscas do LinkedIn pela versão pública (a mesma
// lista de vagas que aparece sem login), sem usar a sua conta. Devolve um item por vaga;
// a descrição completa é lida depois, no "Análise: completar descrição".
//
// Para mudar as buscas: faça a busca no LinkedIn (palavras-chave, local, filtros), copie o
// endereço da barra do navegador e cole em linkedin_buscas, no config.json.
// Sem local no link, busca no Brasil. Sem filtro de data, pega as das últimas 24 h.
// Na coleta retroativa (/buscar N), troca a data pela janela de N dias (sem número,
// DIAS_RETROATIVO) e lê mais páginas.
const BUSCAS = CONFIG.linkedin_buscas;
const PAGINAS = 4;          // páginas por busca (cada uma traz até 10 vagas)
const PAGINAS_RETRO = 25;   // na coleta retroativa (até 250 vagas por busca)
const POR_PAGINA = 10;
const PAUSA_MS = 3000;      // entre uma requisição e outra
// Brasil pelo geoId: a versão pública não reconhece location=Brasil e devolve vagas dos EUA
const GEO_BRASIL = '106057199';
const JANELA_PADRAO = 'r86400'; // últimas 24 h (a coleta roda 2x por dia)

// Parâmetros do link que só fazem sentido na tela logada
const IGNORAR = new Set(['currentJobId', 'origin', 'refresh', 'start', 'trk', 'trackingId', 'refId', 'eBP', 'position', 'pageNum']);

// Sem URL/URLSearchParams: o sandbox do nó Code (task runner do n8n) não tem essas classes.
function lerParametros(link) {
  const q = String(link).split('#')[0].split('?')[1] || '';
  const params = [];
  for (const par of q.split('&')) {
    if (!par) continue;
    const i = par.indexOf('=');
    const dec = (t) => { try { return decodeURIComponent(t.replace(/\+/g, ' ')); } catch (e) { return t; } };
    params.push([dec(i < 0 ? par : par.slice(0, i)), dec(i < 0 ? '' : par.slice(i + 1))]);
  }
  return params;
}

function urlPublica(link, inicio, retroativo = false, dias = DIAS_RETROATIVO) {
  const p = new Map();
  for (const [k, v] of lerParametros(link)) if (!IGNORAR.has(k)) p.set(k, v);
  if (!p.has('location') && !p.has('geoId')) p.set('geoId', GEO_BRASIL);
  if (retroativo) p.set('f_TPR', `r${dias * 86400}`);
  else if (!p.has('f_TPR')) p.set('f_TPR', JANELA_PADRAO);
  p.set('start', String(inicio));
  const qs = [...p].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${qs}`;
}

function extrairCartoes(html) {
  const vagas = [];
  const pega = (trecho, re) => { const m = trecho.match(re); return m ? htmlParaTexto(m[1]).replace(/\s+/g, ' ').trim() : ''; };
  for (const trecho of String(html || '').split(/<li\b/i).slice(1)) {
    const m = trecho.match(/urn:li:jobPosting:(\d{8,12})/) || trecho.match(/\/jobs\/view\/(?:[^"'?\s\/<>]*?-)?(\d{8,12})/);
    if (!m) continue;
    const data = trecho.match(/<time[^>]*datetime="([0-9-]{10})"/i);
    vagas.push({
      id: m[1],
      titulo: pega(trecho, /class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i),
      empresa: pega(trecho, /class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/i),
      local: pega(trecho, /class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i),
      publicado_em: data ? data[1] : null,
    });
  }
  return vagas;
}

async function main(helpers, retroativo = false, dias = DIAS_RETROATIVO) {
  const paginas = retroativo ? PAGINAS_RETRO : PAGINAS;
  const vistas = new Map();
  let cartoesLidos = 0;
  let semTitulo = 0;
  let primeira = true;
  let falhas = 0;
  const erros = [];
  for (const busca of BUSCAS) {
    for (let pagina = 0; pagina < paginas; pagina++) {
      if (!primeira) await new Promise(r => setTimeout(r, PAUSA_MS));
      primeira = false;
      let html;
      try {
        html = await helpers.httpRequest({
          method: 'GET',
          url: urlPublica(busca, pagina * POR_PAGINA, retroativo, dias),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          },
          json: false,
          timeout: 20000,
        });
      } catch (e) {
        // Página além do fim costuma voltar 400; bloqueio volta 429/999. Segue para a próxima busca.
        falhas++;
        erros.push(String(e.message || e).slice(0, 160));
        console.log(`LinkedIn: falha na busca (página ${pagina + 1}): ${String(e.message || e).slice(0, 120)}`);
        break;
      }
      const cartoes = extrairCartoes(String(html));
      if (cartoes.length === 0) break;
      for (const c of cartoes) {
        // A busca do LinkedIn é aproximada ("coordenador de TI" traz qualquer coordenador):
        // só segue o título que passa no filtro_titulo. Cartão sem título legível segue: a
        // análise lê o título na página da vaga e confere o filtro lá
        cartoesLidos++;
        if (!c.titulo) semTitulo++;
        if (vistas.has(c.id) || (c.titulo && !tituloDeInteresse(c.titulo))) continue;
        vistas.set(c.id, {
          fonte: 'linkedin',
          id_externo: c.id,
          link: `https://www.linkedin.com/jobs/view/${c.id}/`,
          titulo: c.titulo || null,
          empresa: c.empresa || null,
          local: c.local || null,
          texto: null,
          publicado_em: c.publicado_em,
        });
      }
      if (cartoes.length < POR_PAGINA) break;
    }
  }
  console.log(`LinkedIn: ${vistas.size} vagas em ${BUSCAS.length} busca(s), ${falhas} falha(s)` +
    (retroativo ? ` (retroativa, ${dias} dias)` : ''));
  const saida = [...vistas.values()].map(json => ({ json }));
  // Sem vagas e com falha: um item de aviso (o "Salvar" ignora; aparece no diagnóstico)
  // Nenhum cartão com título: o LinkedIn deve ter mudado a página. Sem este aviso o filtro
  // deixaria de valer na coleta sem ninguém perceber
  if (cartoesLidos && semTitulo === cartoesLidos) {
    saida.push({ json: { aviso: `LinkedIn: ${semTitulo} vaga(s) sem título legível (a página mudou?); o filtro_titulo só vai valer na análise` } });
  }
  if (!saida.length && falhas) saida.push({ json: { aviso: `LinkedIn: ${falhas} falha(s): ${erros.slice(0, 3).join(' | ')}` } });
  return saida;
}
