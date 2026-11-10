// InfoJobs, Catho, Vagas.com, Remotar e Trampos (rodados pelo nó "Sites e carreiras:
// buscar", src/fontes_novas.js) — sites brasileiros de vagas, pelas páginas públicas de busca (sem
// login). Um termo e uma página por vez, com pausa. Devolve um item por vaga; quando a
// lista não traz a descrição, ela é lida depois, no "Análise: completar descrição"
// (página da vaga, dados JobPosting).
//
// Pesquisa os cargos de termos_de_busca (config.json) e só deixa passar os títulos do
// filtro_titulo (tituloDeInteresse): estes sites são generalistas e cada vaga que passa
// custa uma chamada ao Gemini.
const TERMOS_SITES = CONFIG.termos_de_busca.cargos;
const PAUSA_SITES_MS = 2000;
const UA_SITES = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function slug(termo) {
  return normalizarChave(termo).replace(/\s+/g, '-');
}

function texto1(trecho, re) {
  const m = String(trecho).match(re);
  return m ? htmlParaTexto(m[1]).replace(/\s+/g, ' ').trim() : '';
}

// "Hoje", "Ontem", "Há 3 dias", "em 13/10", "26/10/2026" -> ISO (meio-dia, horário de Brasília)
function dataRelativa(txt, agora = Date.now()) {
  const t = normalizarChave(txt);
  const diasAtras = (n) => new Date(agora - n * 86400000).toISOString();
  if (/\bhoje\b|hora|minuto|agora/.test(t)) return diasAtras(0);
  if (/\bontem\b/.test(t)) return diasAtras(1);
  let m = t.match(/ha (\d+) dia/);
  if (m) return diasAtras(Number(m[1]));
  m = t.match(/ha (\d+) semana/);
  if (m) return diasAtras(Number(m[1]) * 7);
  m = t.match(/ha (\d+) mes/);
  if (m) return diasAtras(Number(m[1]) * 30);
  m = t.match(/(\d{1,2}) (\d{1,2})(?: (\d{4}))?/);
  if (m) {
    const hoje = new Date(agora);
    let ano = m[3] ? Number(m[3]) : hoje.getUTCFullYear();
    let d = Date.UTC(ano, Number(m[2]) - 1, Number(m[1]), 15);
    if (!m[3] && d > agora + 86400000) d = Date.UTC(ano - 1, Number(m[2]) - 1, Number(m[1]), 15);
    return new Date(d).toISOString();
  }
  return null;
}

const SITES = {
  infojobs: {
    nome: 'InfoJobs',
    // Por relevância: ordenado por data, a busca mistura vagas de qualquer área
    paginas: 1, paginasRetro: 3,
    url: (termo, p) => `https://www.infojobs.com.br/empregos.aspx?palabra=${encodeURIComponent(termo).replace(/%20/g, '+')}` +
      `${p > 1 ? `&Page=${p}` : ''}`,
    extrair(html) {
      const vagas = [];
      for (const c of String(html).split('<div id="vacancy').slice(1)) {
        const id = texto1(c, /data-id="(\d+)"/);
        const caminho = (c.match(/data-href="([^"]+)"/) || [])[1];
        if (!id || !caminho) continue;
        const data = (c.match(/js_date" data-value="([^"]+)"/) || [])[1];
        vagas.push({
          id,
          link: `https://www.infojobs.com.br${caminho}`,
          titulo: texto1(c, /js_vacancyTitle[^>]*>([\s\S]*?)<\/h2>/),
          empresa: texto1(c, /href="https:\/\/www\.infojobs\.com\.br\/empresa-[^"]*"[^>]*>([\s\S]*?)(?:<span onclick|<\/a>)/),
          local: texto1(c, /<div class="mb-8">\s*([^<]+)/),
          publicado_em: data ? `${data.replace(/\//g, '-').replace(' ', 'T')}-03:00` : null,
        });
      }
      return vagas;
    },
  },
  catho: {
    nome: 'Catho',
    paginas: 2, paginasRetro: 5, // lista por relevância: lê mais de uma página e filtra pela data
    url: (termo, p) => `https://www.catho.com.br/vagas/${slug(termo)}/${p > 1 ? `?page=${p}` : ''}`,
    extrair(html) {
      const vagas = [];
      for (const c of String(html).split(/<li data-offer-item="/).slice(1)) {
        const id = (c.match(/^(\d+)"/) || [])[1];
        const caminho = (c.match(/<h2 class="title_offer">\s*<a href="([^"]+)"/) || [])[1];
        if (!id || !caminho) continue;
        const empresa = texto1(c, /<p class="mb-2">\s*<span[^>]*>([\s\S]*?)<\/span>/);
        vagas.push({
          id,
          link: `https://www.catho.com.br${caminho}`,
          titulo: texto1(c, /<h2 class="title_offer">\s*<a[^>]*>([\s\S]*?)<\/a>/),
          empresa: /^cliente$/i.test(empresa) ? 'Confidencial (Catho)' : empresa,
          local: texto1(c, /i_job_location"><\/span>\s*(?:<strong>[^<]*<\/strong>\s*-\s*)?([^<]+)/),
          publicado_em: dataRelativa(texto1(c, /(?:Publicada|Atualizada) ([^<]+)</)),
        });
      }
      return vagas;
    },
  },
  'vagas.com': {
    nome: 'Vagas.com',
    // Sem paginação pública: 40 por busca, por relevância (por data mistura outras áreas)
    paginas: 1, paginasRetro: 1,
    url: (termo) => `https://www.vagas.com.br/vagas-de-${slug(termo)}`,
    extrair(html) {
      const vagas = [];
      for (const c of String(html).split(/<li class="vaga\b/).slice(1)) {
        const id = (c.match(/data-id-vaga="(\d+)"/) || [])[1];
        const caminho = (c.match(/class="link-detalhes-vaga"[^>]*href="([^"]+)"/) || [])[1];
        if (!id || !caminho) continue;
        vagas.push({
          id,
          link: `https://www.vagas.com.br${caminho}`,
          titulo: texto1(c, /class="link-detalhes-vaga"[^>]*>([\s\S]*?)<\/a>/),
          empresa: texto1(c, /class="emprVaga">([\s\S]*?)<\/span>/),
          local: texto1(c, /class="vaga-local">\s*(?:<i[^>]*><\/i>)?\s*([^<]+)/),
          publicado_em: dataRelativa(texto1(c, /class="data-publicacao">([\s\S]*?)<\/span>/)),
        });
      }
      return vagas;
    },
  },
  remotar: {
    nome: 'Remotar',
    json: true,
    paginas: 1, paginasRetro: 4, // 50 por página, as mais novas primeiro
    url: (termo, p) => `https://api.remotar.com.br/jobs?search=${encodeURIComponent(termo)}&page=${p}`,
    extrair(resp) {
      return ((resp && resp.data) || []).filter(v => v && v.id && v.active !== false && !v.expired).map(v => {
        const empresa = v.companyDisplayName || (v.company && v.company.name) || '';
        const descricao = htmlParaTexto(v.description || '');
        const titulo = v.title || '';
        return {
          id: String(v.id),
          link: `https://remotar.com.br/job/${v.id}`,
          titulo,
          empresa,
          local: ['Remoto', v.city, v.state].filter(Boolean).join(' · '),
          publicado_em: v.createdAt || null,
          texto: descricao ? cortar([`Título: ${titulo}`, v.subtitle ? `Resumo: ${v.subtitle}` : '',
            `Empresa: ${empresa}`, 'Local/modelo: remoto', `Descrição:\n${descricao}`].filter(Boolean).join('\n'), 12000) : null,
        };
      });
    },
  },
  trampos: {
    nome: 'Trampos',
    json: true,
    paginas: 1, paginasRetro: 3,
    url: (termo, p) => `https://trampos.co/api/v2/opportunities?tr=${encodeURIComponent(termo).replace(/%20/g, '+')}&page=${p}`,
    extrair(resp) {
      return ((resp && resp.opportunities) || []).filter(v => v && v.id).map(v => ({
        id: String(v.id),
        link: `https://trampos.co/oportunidades/${v.id}`,
        titulo: v.name || '',
        empresa: v.custom_company_name || (v.company && v.company.name) || '',
        local: [v.city, v.state, v.home_office ? 'home office' : (v.hybrid ? 'híbrido' : '')].filter(Boolean).join(' · '),
        publicado_em: v.published_at || null,
      }));
    },
  },
};

async function buscarSite(helpers, fonte, retroativo = false) {
  const site = SITES[fonte];
  const dias = retroativo ? DIAS_RETROATIVO : DIAS_RECENTES;
  const paginas = retroativo ? site.paginasRetro : site.paginas;
  const saida = new Map();
  const erros = [];
  let pedidos = 0;
  for (const termo of TERMOS_SITES) {
    for (let p = 1; p <= paginas; p++) {
      if (pedidos++) await new Promise(r => setTimeout(r, PAUSA_SITES_MS));
      let lista;
      try {
        let resp = await helpers.httpRequest({
          method: 'GET',
          url: site.url(termo, p),
          headers: { 'User-Agent': UA_SITES, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: site.json ? 'application/json' : 'text/html' },
          json: !!site.json,
          timeout: 30000,
        });
        if (site.json && typeof resp === 'string') resp = JSON.parse(resp);
        lista = site.extrair(resp);
      } catch (e) {
        erros.push(`${termo} p${p}: ${String(e.message || e).slice(0, 100)}`);
        break;
      }
      let antigas = 0;
      for (const v of lista) {
        if (!recente(v.publicado_em, dias)) { antigas++; continue; }
        if (saida.has(v.id) || !tituloDeInteresse(v.titulo)) continue;
        saida.set(v.id, {
          fonte, id_externo: v.id, link: v.link, titulo: v.titulo, empresa: v.empresa,
          local: v.local, texto: v.texto || null, publicado_em: v.publicado_em,
        });
      }
      // Página vazia ou só com antigas: as próximas não trazem nada novo
      if (!lista.length || (antigas === lista.length && fonte !== 'catho')) break;
    }
  }
  console.log(`${site.nome}: ${saida.size} vagas de interesse, ${erros.length} falha(s)`);
  const itens = [...saida.values()].map(json => ({ json }));
  if (!itens.length && erros.length) itens.push({ json: { aviso: `${site.nome}: ${erros.length} falha(s): ${erros.slice(0, 3).join(' | ')}` } });
  return itens;
}
