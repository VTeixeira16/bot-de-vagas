// Greenhouse, Lever e Workable (rodados pelo nó "Sites e carreiras: buscar",
// src/fontes_novas.js) — páginas de carreira
// das empresas, pelas APIs públicas dessas plataformas (sem login). Uma empresa por vez,
// com pausa. A lista já traz a descrição (Greenhouse e Lever); no Workable, ela é lida
// depois no "Análise: completar descrição" quando a API de detalhe não responde.
//
// Passam só vagas dos locais de interesse (locais_de_interesse no config.json) e com título
// do filtro_titulo (tituloDeInteresse).
//
// Empresas em paginas_de_carreira no config.json: o identificador é o que aparece no
// endereço da página de vagas (job-boards.greenhouse.io/<id>, jobs.lever.co/<id>,
// apply.workable.com/<id>), com o nome exibido no resumo ("" = o que a página informar;
// Lever e Workable não informam, e aí fica o identificador).
const EMPRESAS_CARREIRAS = Object.fromEntries(Object.entries(CONFIG.paginas_de_carreira).map(([p, m]) => [p, Object.keys(m)]));
const NOME_EMPRESA = Object.assign({}, ...Object.values(CONFIG.paginas_de_carreira).map(m =>
  Object.fromEntries(Object.entries(m).filter(([, nome]) => nome))));
const PAUSA_CARREIRAS_MS = 1500;
const UA_CARREIRAS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Sem nenhuma palavra nem país em locais_de_interesse, passa qualquer local.
function localDeInteresse(local, pais = '') {
  const l = CONFIG.locais_de_interesse;
  if (!l.palavras.length && !l.paises.length) return true;
  const p = String(pais || '').trim().toUpperCase();
  return (!!p && l.paises.includes(p)) || temTermo(local, l.palavras);
}

function textoVaga(titulo, empresa, local, descricao) {
  if (!descricao) return null;
  return cortar([`Título: ${titulo}`, `Empresa: ${empresa}`, `Local/modelo: ${local || 'não informado'}`,
    `Descrição:\n${descricao}`].join('\n'), 12000);
}

const PLATAFORMAS = {
  greenhouse: {
    nome: 'Greenhouse',
    async listar(helpers, empresa) {
      const resp = await pedir(helpers, `https://boards-api.greenhouse.io/v1/boards/${empresa}/jobs?content=true`);
      return ((resp && resp.jobs) || []).filter(v => v && v.id).map(v => {
        const local = (v.location && v.location.name) || '';
        const nomeEmpresa = NOME_EMPRESA[empresa] || v.company_name || empresa;
        return {
          id: `${empresa}:${v.id}`,
          link: `https://job-boards.greenhouse.io/${empresa}/jobs/${v.id}`,
          titulo: String(v.title || '').trim(),
          empresa: nomeEmpresa,
          local,
          pais: '',
          publicado_em: v.first_published || v.updated_at || null,
          texto: textoVaga(v.title, nomeEmpresa, local, htmlParaTexto(decodificar(v.content || ''))),
        };
      });
    },
  },
  lever: {
    nome: 'Lever',
    async listar(helpers, empresa) {
      const resp = await pedir(helpers, `https://api.lever.co/v0/postings/${empresa}?mode=json`);
      return (Array.isArray(resp) ? resp : []).filter(v => v && v.id).map(v => {
        const c = v.categories || {};
        const lugares = [].concat(c.allLocations || c.location || []).join('; ');
        const local = [lugares, v.workplaceType === 'remote' ? 'remoto' : (v.workplaceType === 'hybrid' ? 'híbrido' : '')]
          .filter(Boolean).join(' · ');
        const listas = (v.lists || []).map(l => `${l.text}:\n${htmlParaTexto(l.content || '')}`).join('\n\n');
        const descricao = [v.descriptionPlain, listas, v.additionalPlain].filter(Boolean).join('\n\n').trim();
        return {
          id: `${empresa}:${v.id}`,
          link: v.hostedUrl || `https://jobs.lever.co/${empresa}/${v.id}`,
          titulo: String(v.text || '').trim(),
          empresa: NOME_EMPRESA[empresa] || empresa,
          local,
          pais: v.country || '',
          publicado_em: v.createdAt ? new Date(Number(v.createdAt)).toISOString() : null,
          texto: textoVaga(v.text, NOME_EMPRESA[empresa] || empresa, local, descricao),
        };
      });
    },
  },
  workable: {
    nome: 'Workable',
    async listar(helpers, empresa) {
      const resp = await pedir(helpers, `https://apply.workable.com/api/v3/accounts/${empresa}/jobs`, 'POST',
        { query: '', location: [], department: [], worktype: [], remote: [] });
      return ((resp && resp.results) || []).filter(v => v && v.shortcode).map(v => {
        const l = v.location || {};
        const local = [l.city, l.region, l.country, v.remote ? 'remoto' : (v.workplace === 'hybrid' ? 'híbrido' : '')]
          .filter(Boolean).join(' · ');
        return {
          id: `${empresa}:${v.shortcode}`,
          link: `https://apply.workable.com/${empresa}/j/${v.shortcode}/`,
          titulo: String(v.title || '').trim(),
          empresa: NOME_EMPRESA[empresa] || empresa,
          local,
          pais: l.countryCode || '',
          publicado_em: v.published || null,
          texto: null,
          shortcode: v.shortcode,
        };
      });
    },
    // Descrição pela API de detalhe; se falhar, fica para o "Análise: completar descrição"
    async detalhar(helpers, empresa, v) {
      try {
        const d = await pedir(helpers, `https://apply.workable.com/api/v2/accounts/${empresa}/jobs/${v.shortcode}`);
        const descricao = ['description', 'requirements', 'benefits']
          .map(k => htmlParaTexto((d && d[k]) || '')).filter(Boolean).join('\n\n');
        return textoVaga(v.titulo, v.empresa, v.local, descricao);
      } catch (e) {
        return null;
      }
    },
  },
};

async function pedir(helpers, url, method = 'GET', body) {
  let resp = await helpers.httpRequest({
    method, url, json: true, timeout: 30000,
    headers: { 'User-Agent': UA_CARREIRAS, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body } : {}),
  });
  if (typeof resp === 'string') resp = JSON.parse(resp);
  return resp;
}

async function buscarCarreira(helpers, fonte, retroativo = false, dias = DIAS_RETROATIVO) {
  const plat = PLATAFORMAS[fonte];
  const janela = retroativo ? dias : DIAS_RECENTES;
  const saida = new Map();
  const erros = [];
  let pedidos = 0;
  for (const empresa of EMPRESAS_CARREIRAS[fonte] || []) {
    if (pedidos++) await new Promise(r => setTimeout(r, PAUSA_CARREIRAS_MS));
    let lista;
    try {
      lista = await plat.listar(helpers, empresa);
    } catch (e) {
      erros.push(`${empresa}: ${String(e.message || e).slice(0, 100)}`);
      continue;
    }
    for (const v of lista) {
      if (saida.has(v.id) || !recente(v.publicado_em, janela)) continue;
      if (!localDeInteresse(v.local, v.pais) || !tituloDeInteresse(v.titulo)) continue;
      if (!v.texto && plat.detalhar) {
        await new Promise(r => setTimeout(r, PAUSA_CARREIRAS_MS));
        v.texto = await plat.detalhar(helpers, empresa, v);
      }
      saida.set(v.id, {
        fonte, id_externo: v.id, link: v.link, titulo: v.titulo, empresa: v.empresa,
        local: v.local, texto: v.texto || null, publicado_em: v.publicado_em,
      });
    }
  }
  console.log(`${plat.nome}: ${saida.size} vagas de interesse, ${erros.length} falha(s)`);
  const itens = [...saida.values()].map(json => ({ json }));
  if (!itens.length && erros.length) itens.push({ json: { aviso: `${plat.nome}: ${erros.length} falha(s): ${erros.slice(0, 3).join(' | ')}` } });
  return itens;
}
