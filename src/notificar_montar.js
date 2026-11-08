// Nó "Resumo: montar mensagens" — recebe as vagas ainda não notificadas e monta as
// mensagens do Telegram (HTML, até ~3800 caracteres cada). O comando /recentes usa o mesmo
// código (nó "Recentes: montar mensagens") com outro título e sem marcar nada.
const CORTE = CONFIG.resumo.nota_minima;   // nota mínima para aparecer no resumo
const MAX_VAGAS = CONFIG.resumo.max_vagas;  // limite de vagas por resumo
const ENVIAR_SEM_VAGAS = true;
const LIMITE_MSG = 3800;

const NOME_FONTE = {
  linkedin: 'LinkedIn', gupy: 'Gupy', remotive: 'via Remotive', indeed: 'Indeed',
  glassdoor: 'Glassdoor', catho: 'Catho', infojobs: 'InfoJobs', 'vagas.com': 'Vagas.com',
  remotar: 'Remotar', wellfound: 'Wellfound', programathor: 'ProgramaThor', revelo: 'Revelo',
  trampos: 'Trampos', greenhouse: 'Greenhouse', lever: 'Lever', workable: 'Workable',
};

// /buscar linkedin (etc.): o resumo vem só com as fontes pedidas ("fontes_pedidas" na consulta)
function fontesPedidas(s) {
  const f = String((s && s.fontes_pedidas) || 'todas').trim();
  if (!f || f === 'todas') return '';
  return f.split(' ').map(x => (NOME_FONTE[x] || x).replace(/^via /, '')).join(', ');
}

function esc(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Tamanho máximo de cada campo no resumo. Título, empresa e link vêm de sites de vagas, e
// resumo/atende/gaps vêm do modelo: sem corte, uma vaga com texto enorme passaria do limite
// do Telegram (4096), o envio falharia antes de marcar as vagas como enviadas e o mesmo
// erro se repetiria em todo resumo.
const MAX_CAMPO = { titulo: 200, empresa: 120, local: 120, resumo: 300, item: 160, link: 1500 };
const curto = (t, max) => cortar(String(t || '').replace(/\s+/g, ' ').trim(), max);
const lista = (x) => (Array.isArray(x) ? x : []);

function linkDaVaga(link) {
  const l = String(link || '');
  return /^https?:\/\//i.test(l) && l.length <= MAX_CAMPO.link ? `➡️ <a href="${esc(l)}">Abrir vaga</a>` : '➡️ (link indisponível)';
}

function bloco(v, n) {
  const a = (typeof v.analise === 'string' ? JSON.parse(v.analise) : v.analise) || {};
  const linhas = [
    `<b>${n}. ${v.score} · ${esc(curto(v.titulo, MAX_CAMPO.titulo) || 'Vaga sem título')}</b>`,
    `${esc(curto(v.empresa, MAX_CAMPO.empresa) || 'Empresa não informada')} · ${esc(curto(v.local, MAX_CAMPO.local) || 'local não informado')} · ${esc(NOME_FONTE[v.fonte] || v.fonte)}`,
  ];
  if (a.totalmente_presencial) linhas.push('🏢 <b>TOTALMENTE PRESENCIAL</b> — avalie antes de se candidatar');
  if (a.resumo) linhas.push(`💬 ${esc(curto(a.resumo, MAX_CAMPO.resumo))}`);
  const atende = lista(a.atende).slice(0, 3).map(x => curto(x, MAX_CAMPO.item));
  const gaps = lista(a.gaps).slice(0, 2).map(x => curto(x, MAX_CAMPO.item));
  if (atende.length) linhas.push(`✅ ${esc(atende.join('; '))}`);
  if (gaps.length) linhas.push(`⚠️ ${esc(gaps.join('; '))}`);
  linhas.push(linkDaVaga(v.link));
  return linhas.join('\n');
}

function fmtData(iso) {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// Resumo vazio: diz o porquê, com a situação do banco que vem junto na consulta.
function motivoVazio(s, so = '') {
  if (!s || s.coletadas_24h === undefined) return '';
  const n = (v) => Number(v || 0);
  if (so) return `\n🗂️ ${esc(so)}: ${n(s.coletadas_24h)} coletadas nas últimas 24 h (vaga que já estava no banco, ` +
    `mesmo por outra fonte, não entra de novo). As vagas das outras fontes ficam para o resumo das ${CONFIG.horarios.resumo}.`;
  const linhas = [`🗂️ ${n(s.coletadas_24h)} coletadas nas últimas 24 h · ${n(s.pendentes)} aguardando análise` +
    ` · última coleta: ${fmtData(s.ultima_coleta)}`];
  if (n(s.pendentes)) linhas.push(`A análise roda às ${CONFIG.horarios.analise}; as pendentes entram no próximo resumo.`);
  else if (!n(s.coletadas_24h)) linhas.push('Nenhuma vaga nova nas buscas: vale conferir os termos e as buscas do LinkedIn.');
  return '\n' + linhas.join('\n');
}

function main(items, opcoes = {}) {
  const todas = items.map(i => i.json);
  const so = fontesPedidas(todas[0]);
  const titulo = (opcoes.titulo || 'Vagas novas') + (so ? ` (${so})` : '');
  const linhas = todas.filter(v => v && v.id_externo);

  // Mesma vaga em fontes diferentes: fica a de maior nota.
  const porChave = new Map();
  for (const v of linhas.filter(v => v.status === 'analisada')) {
    const k = `${(v.titulo || '').toLowerCase().trim()}|${(v.empresa || '').toLowerCase().trim()}`;
    if (!porChave.has(k) || (porChave.get(k).score || 0) < (v.score || 0)) porChave.set(k, v);
  }
  const analisadas = [...porChave.values()];
  const acima = analisadas.filter(v => (v.score || 0) >= CORTE).sort((a, b) => b.score - a.score);
  const boas = acima.slice(0, MAX_VAGAS);
  // As que passaram do limite ficam para o próximo resumo (não são marcadas como enviadas).
  const adiadas = new Set(acima.slice(MAX_VAGAS).map(v => v.id));
  const ids = linhas.map(v => v.id).filter(id => !adiadas.has(id));
  const abaixo = analisadas.length - acima.length;
  const semLeitura = linhas.filter(v => v.status === 'erro_fetch' || v.status === 'erro_llm');

  if (!linhas.length) {
    return ENVIAR_SEM_VAGAS
      ? [{ json: { texto: opcoes.vazio || ((so ? `🎯 Nenhuma vaga nova de ${esc(so)} desde o último resumo.`
        : '🎯 Nenhuma vaga nova desde o último resumo.') + motivoVazio(todas[0], so)), ids: '' } }]
      : [];
  }

  const blocos = [];
  blocos.push(`🎯 <b>${esc(titulo)}</b> — ${boas.length} com aderência ≥ ${CORTE}` +
    ` (de ${analisadas.length} analisadas${abaixo ? `, ${abaixo} abaixo do corte` : ''})` +
    (adiadas.size ? `\n➕ Mais ${adiadas.size} acima do corte ficam para o próximo resumo.` : ''));
  boas.forEach((v, i) => blocos.push(bloco(v, i + 1)));
  if (semLeitura.length) {
    blocos.push('🔎 <b>Não consegui ler estas (vale abrir à mão):</b>\n' +
      semLeitura.slice(0, 10).map(v => {
        const nome = esc(curto(v.titulo, MAX_CAMPO.titulo) || 'vaga ' + curto(v.id_externo, 40));
        const l = String(v.link || '');
        return /^https?:\/\//i.test(l) && l.length <= MAX_CAMPO.link ? `• <a href="${esc(l)}">${nome}</a>` : `• ${nome}`;
      }).join('\n'));
  }

  // Quebra em mensagens respeitando o limite do Telegram.
  const mensagens = [];
  let atual = '';
  for (const b of blocos) {
    if (atual && (atual.length + b.length + 2) > LIMITE_MSG) { mensagens.push(atual); atual = ''; }
    atual = atual ? `${atual}\n\n${b}` : b;
  }
  if (atual) mensagens.push(atual);

  return mensagens.map((texto, i) => ({ json: { texto, ids: i === 0 ? ids.join(',') : '' } }));
}
