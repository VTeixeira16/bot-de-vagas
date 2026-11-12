// Nó "Análise: completar descrição" — para vagas ainda sem texto, lê a página pública da
// vaga (sem login), uma por vez em cada site, com pausa; sites diferentes ao mesmo tempo. LinkedIn tem leitor próprio; os
// outros sites (InfoJobs, Catho, Vagas.com, Trampos...) pelos dados JobPosting (JSON-LD)
// que a página traz para o Google. Marca ok=false quando não consegue: a vaga é tentada de
// novo nas próximas análises e, se não der, segue para o resumo só com o link.
//
// Antes de ler (e de gastar uma chamada ao Gemini), confere o título de novo no
// filtro_titulo: a vaga pode ter sido coletada com um filtro mais frouxo, que o usuário
// apertou depois. Fora do filtro, sai com ok=false e fora_do_filtro=true (vira "descartada").
const PAUSA_MS = 3000;

// O link vem do site de vagas. Só lê página pública na internet: http(s), nome de domínio
// com ponto, sem usuário/senha no endereço e sem IP ou nome interno (postgres, n8n,
// localhost...). Sem isso, um link forjado faria o n8n abrir serviços da rede interna.
function linkPublico(link) {
  const m = String(link || '').match(/^https?:\/\/([^\/?#]*)/i);
  if (!m) return false;
  const autoridade = m[1];
  if (!autoridade || autoridade.includes('@') || autoridade.includes('\\')) return false;
  const host = autoridade.replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.startsWith('[')) return false;  // nome interno ou IPv6
  if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) return false;   // IP
  if (/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)) return false;
  return /^[a-z0-9.-]+$/.test(host);
}

function extrairVagaLinkedin(html) {
  const pega = (re) => { const m = html.match(re); return m ? htmlParaTexto(m[1]).replace(/\s+/g, ' ').trim() : ''; };
  const titulo = pega(/class="[^"]*top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\/h\d>/i);
  const empresa = pega(/class="[^"]*topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    || pega(/class="[^"]*topcard__flavor[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const local = pega(/class="[^"]*topcard__flavor--bullet[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const mDesc = html.match(/class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const criterios = pega(/class="[^"]*description__job-criteria-list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  const descricao = mDesc ? htmlParaTexto(mDesc[1]) : htmlParaTexto(html);
  return { titulo, empresa, local, descricao, criterios };
}

// Conteúdo de cada <script type="application/ld+json"> da página. Busca com indexOf (linear):
// a regex antiga varria o resto da página a cada <script sem ">", e uma página malformada
// levava dezenas de segundos.
function blocosJsonLd(html) {
  const s = String(html || '');
  const baixo = s.toLowerCase();
  const blocos = [];
  let i = 0;
  while ((i = baixo.indexOf('application/ld+json', i)) >= 0) {
    const ini = baixo.lastIndexOf('<script', i);
    const abre = baixo.indexOf('>', i);
    if (ini < 0 || abre < 0 || i - ini > 500 || baixo.lastIndexOf('>', i) > ini) { i += 19; continue; }
    const fim = baixo.indexOf('</script>', abre);
    if (fim < 0) break;
    blocos.push(s.slice(abre + 1, fim));
    i = fim + 9;
  }
  return blocos;
}

// Dados schema.org JobPosting da página (<script type="application/ld+json">)
function extrairJobPosting(html) {
  for (const bloco of blocosJsonLd(html)) {
    let dado;
    try { dado = JSON.parse(bloco.trim()); } catch (e) { continue; }
    const lista = Array.isArray(dado) ? dado : (dado && dado['@graph']) || [dado];
    const jp = lista.find(x => x && (x['@type'] === 'JobPosting' || (Array.isArray(x['@type']) && x['@type'].includes('JobPosting'))));
    if (!jp) continue;
    const org = jp.hiringOrganization || {};
    const lugares = [].concat(jp.jobLocation || []).map(l => (l && l.address) || {});
    const local = lugares.map(a => [a.addressLocality, a.addressRegion].filter(Boolean).join(' - ')).filter(Boolean).join('; ');
    const remoto = jp.jobLocationType === 'TELECOMMUTE' ? 'remoto' : '';
    return {
      titulo: decodificar(jp.title || ''),
      empresa: decodificar(typeof org === 'string' ? org : org.name || ''),
      local: [local, remoto].filter(Boolean).join(' · '),
      descricao: htmlParaTexto(decodificar(jp.description || '')),
      publicado: jp.datePosted || null,
      extras: [
        jp.employmentType ? `Contrato: ${[].concat(jp.employmentType).join(', ')}` : '',
        jp.experienceRequirements ? `Experiência: ${typeof jp.experienceRequirements === 'string' ? jp.experienceRequirements : JSON.stringify(jp.experienceRequirements)}` : '',
        jp.baseSalary ? `Salário: ${JSON.stringify(jp.baseSalary)}` : '',
      ].filter(Boolean).join('\n'),
    };
  }
  return null;
}

// Uma fila por fonte (cada fonte é um site): dentro da fila, uma vaga por vez com pausa;
// as filas rodam ao mesmo tempo. A saída mantém a ordem da entrada.
async function main(items, helpers) {
  const filas = new Map();
  items.forEach((item, i) => {
    const k = item.json.fonte || '?';
    if (!filas.has(k)) filas.set(k, []);
    filas.get(k).push(i);
  });
  const saida = new Array(items.length);
  await Promise.all([...filas.values()].map(async (indices) => {
    let primeira = true;
    for (const i of indices) {
      const v = { ...items[i].json, ok: true };
      const semTitulo = !v.titulo;
      const precisaLer = !v.texto && (v.fonte === 'linkedin' || v.link);
      if (foraDoFiltro(v)) {
        saida[i] = { json: v };
        continue;
      }
      if (precisaLer) {
        if (!primeira) await new Promise(r => setTimeout(r, PAUSA_MS));
        primeira = false;
        await completar(v, helpers);
        // Vaga que chegou sem título (o site não mostrou na lista): confere com o da página
        if (v.ok && semTitulo) foraDoFiltro(v);
      }
      saida[i] = { json: v };
    }
  }));
  return saida;
}

// Título que não passa no filtro_titulo: marca a vaga para sair da fila. Sem título não dá
// para saber: segue.
function foraDoFiltro(v) {
  if (!v.titulo || tituloDeInteresse(v.titulo)) return false;
  v.ok = false;
  v.fora_do_filtro = true;
  v.erro = 'título fora do filtro_titulo';
  return true;
}

async function completar(v, helpers) {
  if (v.fonte === 'linkedin') {
    try {
      const html = await helpers.httpRequest({
        method: 'GET',
        url: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${v.id_externo}`,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
        json: false,
        timeout: 20000,
      });
      const d = extrairVagaLinkedin(String(html).slice(0, MAX_HTML));
      if (!d.titulo && d.descricao.length < 200) throw new Error('página sem conteúdo de vaga');
      v.titulo = d.titulo || v.titulo;
      v.empresa = d.empresa || v.empresa;
      v.local = d.local || v.local;
      v.texto = cortar([
        `Título: ${d.titulo}`, `Empresa: ${d.empresa}`, `Local: ${d.local}`,
        d.criterios ? `Critérios: ${d.criterios}` : '',
        `Descrição:\n${d.descricao}`,
      ].filter(Boolean).join('\n'), 12000);
    } catch (e) {
      v.ok = false;
      v.erro = String(e.message || e).slice(0, 200);
    }
    return;
  }
  if (!linkPublico(v.link)) {
    v.ok = false;
    v.erro = 'link recusado (não é uma página pública)';
    return;
  }
  try {
    const html = await helpers.httpRequest({
      method: 'GET',
      url: v.link,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      json: false,
      timeout: 20000,
    });
    const d = extrairJobPosting(String(html).slice(0, MAX_HTML));
    if (!d || d.descricao.length < 100) throw new Error('página sem dados da vaga (JobPosting)');
    v.titulo = v.titulo || d.titulo;
    v.empresa = v.empresa || d.empresa;
    v.local = v.local || d.local;
    v.texto = cortar([
      `Título: ${d.titulo || v.titulo}`, `Empresa: ${d.empresa || v.empresa}`, `Local: ${d.local || v.local}`,
      d.extras, `Descrição:\n${d.descricao}`,
    ].filter(Boolean).join('\n'), 12000);
  } catch (e) {
    v.ok = false;
    v.erro = String(e.message || e).slice(0, 200);
  }
}
