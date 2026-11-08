// Mensagens do Telegram sobre o perfil (o resumo do currículo que o Gemini usa para dar a
// nota): o rascunho gerado do PDF ("Currículo: montar resposta"), o /usar ("Usar: montar
// mensagem") e o /perfil ("Perfil: montar mensagem"). O perfil em uso é o último enviado
// pelo Telegram e confirmado com /usar; sem nenhum, o config/perfil.md (PERFIL, do build.py).
const LIMITE_MSG = 3800;

function esc(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Markdown simples -> HTML do Telegram: títulos e **negrito** em negrito
function formatar(md) {
  return esc(md).split('\n').map(l => {
    const t = l.match(/^#{1,6}\s+(.*)$/);
    return t ? `<b>${t[1]}</b>` : l;
  }).join('\n').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

function fmtData(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Versão curta do perfil para o Telegram: só palavras-chave, um resumo profissional breve,
// local e modelo de trabalho e cargos-alvo (o texto inteiro continua indo para as notas e
// aparece com /perfil completo). As seções vêm pelos títulos do Markdown (prompt_curriculo.md);
// sem nenhuma delas (perfil.md escrito à mão em outro formato), mostra o texto inteiro.
const SECOES_CURTAS = [
  { titulo: '🔑 Palavras-chave', acha: [/^palavras?[\s-]*chave/, /^competencias tecnicas/, /^competencias\b/], max: 400 },
  { titulo: '📝 Resumo profissional', acha: [/^resumo/], max: 450 },
  { titulo: '📍 Local e modelo de trabalho', acha: [/^local/, /modelo de trabalho/], max: 450 },
  { titulo: '🎯 Cargos-alvo', acha: [/^cargos?[\s-]*alvo/], max: 600 },
];

function semAcento(t) {
  return String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// Corta no fim de uma palavra, com reticências
function encurtar(t, max) {
  if (t.length <= max) return t;
  const c = t.slice(0, max);
  const i = Math.max(c.lastIndexOf(' '), c.lastIndexOf('\n'));
  return (i > max * 0.6 ? c.slice(0, i) : c).replace(/[\s,;·•-]+$/, '') + '…';
}

// { títuloNormalizado: corpo } de cada seção do Markdown, mais o título principal (# ...)
function secoes(md) {
  const r = { principal: '', lista: [] };
  let atual = null;
  for (const l of String(md || '').split('\n')) {
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (h[1].length === 1 && !r.principal) { r.principal = h[2].trim(); atual = null; continue; }
      atual = { nome: semAcento(h[2].replace(/\*\*/g, '').replace(/\(.*?\)/g, '')), corpo: [] };
      r.lista.push(atual);
    } else if (atual) {
      atual.corpo.push(l);
    }
  }
  for (const s of r.lista) s.corpo = s.corpo.join('\n').trim();
  return r;
}

function perfilCurto(md) {
  const s = secoes(md);
  const blocos = [];
  for (const sec of SECOES_CURTAS) {
    let achada = null;
    for (const re of sec.acha) {
      achada = s.lista.find(x => x.corpo && re.test(x.nome));
      if (achada) break;
    }
    if (achada) blocos.push(`<b>${sec.titulo}</b>\n${formatar(encurtar(achada.corpo, sec.max))}`);
  }
  if (!blocos.length) return [formatar(md)];
  if (s.principal) blocos.unshift(`<b>${esc(s.principal)}</b>`);
  return blocos;
}

// Quebra em mensagens de até LIMITE_MSG caracteres, de preferência entre linhas, sem
// cortar uma marcação <b>...</b> no meio
function dividir(blocos) {
  const msgs = [];
  let atual = '';
  const linhas = blocos.join('\n\n').split('\n');
  for (let l of linhas) {
    while (l.length > LIMITE_MSG) { // linha enorme: corta em pedaços
      if (atual) { msgs.push(atual); atual = ''; }
      msgs.push(l.slice(0, LIMITE_MSG));
      l = l.slice(LIMITE_MSG);
    }
    if (atual && atual.length + l.length + 1 > LIMITE_MSG) { msgs.push(atual); atual = ''; }
    atual = atual ? `${atual}\n${l}` : l;
  }
  if (atual.trim()) msgs.push(atual);
  return msgs.map(texto => ({ json: { texto } }));
}

// Rascunho novo (ou erro). leitura: saída do "Currículo: interpretar"; salvo: linha inserida
function respostaCurriculo(leitura, salvo) {
  if (!leitura.ok) return [{ json: { texto: leitura.texto } }];
  if (!salvo || !salvo.id) {
    return [{ json: { texto: '⚠️ Montei o perfil, mas não consegui guardar no banco. O perfil em uso continua o mesmo; tente de novo.' } }];
  }
  const blocos = [`📄 <b>Perfil novo montado a partir de "${esc(leitura.origem)}"</b>\n` +
    'Ainda <b>não</b> está em uso. Confira abaixo e mande /usar para as próximas notas usarem este perfil. ' +
    'Para ajustar, mande o PDF de novo com uma legenda (ex.: "quero só vagas remotas").'];
  if (leitura.avisos && leitura.avisos.length) blocos.push('⚠️ <b>Confira</b>\n' + leitura.avisos.map(a => `• ${esc(a)}`).join('\n'));
  blocos.push(...perfilCurto(leitura.perfil));
  blocos.push('👉 /usar para usar este perfil · /perfil novo para ver o texto inteiro · /perfil para ver o que está em uso');
  return dividir(blocos);
}

// /usar. linha: { ativados, criado_em }
function respostaUsar(linha) {
  if (!linha || !Number(linha.ativados)) {
    return [{ json: { texto: '📄 Não há perfil novo esperando confirmação. Mande o PDF do seu currículo aqui no chat (como arquivo) e eu monto um.' } }];
  }
  return [{ json: { texto: `✅ Pronto: o perfil do currículo enviado em ${fmtData(linha.criado_em)} passa a valer a partir da próxima análise ` +
    `(${CONFIG.horarios.analise}, ou agora com /buscar). As vagas já analisadas mantêm a nota.\n` +
    'Para voltar ao perfil do arquivo (config/perfil.md): /perfil arquivo' } }];
}

// /perfil (curto), /perfil completo, /perfil novo (o rascunho inteiro) e /perfil arquivo.
// linha: { perfil, perfil_em, rascunho, rascunho_em, pedido }
function respostaPerfil(linha) {
  const l = linha || {};
  const blocos = [];
  if (l.pedido === 'novo') {
    if (!l.rascunho) return [{ json: { texto: '📄 Não há perfil novo esperando o /usar. Mande o PDF do seu currículo aqui no chat para montar um.' } }];
    return dividir([`📄 <b>Perfil novo, de ${fmtData(l.rascunho_em)}</b> (texto inteiro; ainda não está em uso)`,
      formatar(l.rascunho), '👉 /usar para usar este perfil']);
  }
  if (l.pedido === 'arquivo') blocos.push('↩️ Voltei para o perfil do arquivo (config/perfil.md).');
  blocos.push(l.perfil
    ? `📄 <b>Perfil em uso:</b> o do currículo enviado em ${fmtData(l.perfil_em)} (para voltar ao do arquivo: /perfil arquivo)`
    : '📄 <b>Perfil em uso:</b> o do arquivo config/perfil.md (para trocar, mande o PDF do currículo aqui)');
  if (l.rascunho_em) blocos.push(`⏳ Há um perfil novo, de ${fmtData(l.rascunho_em)}, esperando o /usar (/perfil novo mostra).`);
  if (l.pedido === 'completo') {
    blocos.push(formatar(l.perfil || PERFIL));
  } else {
    blocos.push(...perfilCurto(l.perfil || PERFIL));
    blocos.push('👉 /perfil completo para ver o texto inteiro (o que vai para as notas)');
  }
  return dividir(blocos);
}
