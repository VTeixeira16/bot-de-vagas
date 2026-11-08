// Nó "Comando: interpretar" — recebe do container telegram (servidor/telegram_comandos.py)
// o texto que você mandou ao bot e decide a ação. Para /ajuda e comando desconhecido, já
// devolve o texto da resposta.
const ACOES = {
  vagas: 'vagas', resumo: 'vagas',
  buscar: 'buscar', coletar: 'buscar', atualizar: 'buscar',
  recentes: 'recentes', melhores: 'recentes',
  status: 'status', situacao: 'status',
  ajuda: 'ajuda', help: 'ajuda', start: 'ajuda', comandos: 'ajuda',
  curriculo: 'curriculo', cv: 'curriculo',
  usar: 'usar',
  perfil: 'perfil',
};
const COMO_MANDAR_CURRICULO = '📄 Para trocar o perfil usado nas notas, mande o <b>PDF do seu currículo</b> aqui no chat ' +
  '(clipe → Arquivo; até 5 MB). O Gemini monta um perfil novo, mantendo as suas preferências atuais ' +
  '(cargos-alvo, local, o que não quer), e eu mostro para você conferir antes de usar. ' +
  'Na legenda do arquivo dá para pedir ajustes, como "agora só quero vagas remotas".';
const DIAS_PADRAO = 7;
const DIAS_MAX = 30;
const NOVAS = ['infojobs', 'catho', 'vagas.com', 'remotar', 'trampos', 'greenhouse', 'lever', 'workable'].filter(f => CONFIG.fontes[f]);

// Fontes ligadas no config.json (fontes); as desligadas não aparecem nem podem ser pedidas
const ATIVAS = Object.keys(CONFIG.fontes).filter(f => CONFIG.fontes[f]);

const AJUDA = [
  '🤖 <b>Comandos do bot de vagas</b>',
  '/vagas — manda agora o resumo das vagas já analisadas e ainda não enviadas',
  '/buscar — coleta agora em todas as fontes, analisa e manda o resumo',
  '/buscar 90 — o mesmo, mas buscando as vagas dos últimos 90 dias (demora mais)',
  `/buscar ${ATIVAS[0]} — só algumas fontes (${ATIVAS.join(', ')}` +
    `${NOVAS.length ? '; carreiras = sites brasileiros e páginas de carreira' : ''}); junta com 90: /buscar 90 ${ATIVAS.slice(-2).join(' ')}`,
  `/recentes — repete as melhores dos últimos ${DIAS_PADRAO} dias, mesmo as já enviadas (/recentes 3 = 3 dias)`,
  '/status — situação do bot e do banco',
  '📄 PDF do currículo — mande aqui (como arquivo) para montar um perfil novo; /usar confirma',
  '/perfil — resumo do perfil usado nas notas (/perfil completo = texto inteiro; /perfil novo = o que espera o /usar; /perfil arquivo = volta ao do config/perfil.md)',
  '/ajuda — esta lista',
].join('\n');

// Fontes que o /buscar aceita (/buscar gupy, /buscar 90 gupy linkedin)
// Chaves já normalizadas (normalizarChave: "Vagas.com" vira "vagas com")
const FONTES = {
  linkedin: 'linkedin', gupy: 'gupy', remotive: 'remotive', infojobs: 'infojobs', catho: 'catho',
  vagas: 'vagas.com', 'vagas com': 'vagas.com', vagascom: 'vagas.com', remotar: 'remotar', trampos: 'trampos',
  greenhouse: 'greenhouse', lever: 'lever', workable: 'workable',
  // /buscar carreiras: todas as fontes novas de uma vez (sites brasileiros + páginas de
  // carreira das empresas), sem LinkedIn, Gupy e Remotive
  carreiras: NOVAS, carreira: NOVAS, empresas: NOVAS,
};
const NOME_FONTE_CMD = {
  linkedin: 'LinkedIn', gupy: 'Gupy', remotive: 'Remotive', infojobs: 'InfoJobs', catho: 'Catho',
  'vagas.com': 'Vagas.com', remotar: 'Remotar', trampos: 'Trampos',
  greenhouse: 'Greenhouse', lever: 'Lever', workable: 'Workable',
};

function main(entrada) {
  const corpo = (entrada && entrada.body) || entrada || {};
  const texto = String(corpo.texto || '').trim();
  const [primeira = '', ...resto] = texto.split(/\s+/).filter(Boolean);
  const comando = normalizarChave(primeira.replace(/^\//, '').split('@')[0]);
  const acao = ACOES[comando];

  const numeros = resto.map(a => parseInt(a, 10)).filter(n => Number.isFinite(n) && n > 0);
  const n = numeros.length ? numeros[0] : NaN;
  const dias = Number.isFinite(n) ? Math.min(n, DIAS_MAX) : DIAS_PADRAO;

  // PDF do currículo: o servidor/telegram_comandos.py manda como /curriculo, com o arquivo
  if (acao === 'curriculo') {
    return [{ json: corpo.arquivo
      ? { acao: 'curriculo', comando, dias, texto: '' }
      : { acao: 'ajuda', comando, dias, texto: COMO_MANDAR_CURRICULO } }];
  }
  if (acao === 'perfil') {
    const args = resto.map(normalizarChave);
    const pedido = args.includes('arquivo') ? 'arquivo'
      : args.some(a => a === 'novo' || a === 'rascunho') ? 'novo'
        : args.some(a => a === 'completo' || a === 'tudo' || a === 'inteiro') ? 'completo' : 'ver';
    return [{ json: { acao, comando, dias, pedido, texto: '' } }];
  }

  if (!acao) {
    return [{ json: { acao: 'ajuda', comando, dias,
      texto: `Não entendi "${esc(cortar(texto, 40))}".\n\n${AJUDA}` } }];
  }

  // /buscar [90|tudo] [gupy|linkedin|remotive ...]: em qualquer ordem
  let retroativo = false;
  const fontes = [];
  if (acao === 'buscar') {
    for (const arg of resto) {
      const a = normalizarChave(arg);
      if (/^\d+$/.test(a)) { if (Number(a) > 1) retroativo = true; continue; }
      if (/^(tudo|todas|retroativ[oa])$/.test(a)) { retroativo = true; continue; }
      // "carreiras" com todas elas desligadas também conta como desligada
      const pedidas = [].concat(FONTES[a] || []);
      if (pedidas.length && pedidas.every(f => ATIVAS.includes(f))) {
        for (const f of pedidas) if (!fontes.includes(f)) fontes.push(f);
        continue;
      }
      const desligada = FONTES[a] ? ' está desligada no config.json (fontes)' : '';
      return [{ json: { acao: 'ajuda', comando, dias,
        texto: (desligada ? `A fonte "${esc(cortar(arg, 30))}"${desligada}.` : `Não conheço a fonte "${esc(cortar(arg, 30))}".`) +
          ` Use: ${ATIVAS.join(', ')}.\n\n${AJUDA}` } }];
    }
  }
  const nomesFontes = (fontes.length ? fontes : ATIVAS).map(f => NOME_FONTE_CMD[f]).join(', ');
  return [{ json: { acao, comando, dias, retroativo, fontes, nomesFontes,
    texto: acao === 'ajuda' ? AJUDA : '' } }];
}

function esc(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
