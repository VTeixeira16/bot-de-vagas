// Erros do Gemini: o que cada um quer dizer e o que fazer. Usado pelo "... conferir
// resposta" (decide se tenta o próximo modelo), pelo aviso no Telegram e pelo currículo.
// Modelos na ordem de tentativa: o modelo_gemini e depois os modelos_reserva (config.json).
const MODELOS = [CONFIG.modelo_gemini, ...CONFIG.modelos_reserva.filter(m => m !== CONFIG.modelo_gemini)];
// Cota do modelo (429) e sobrecarga (5xx): outro modelo pode responder
const RETENTAVEIS = [429, 500, 502, 503, 504];

// Cota estourada: qual limite (por minuto ou por dia), de quantos pedidos e em qual modelo.
// O Google manda isso em error.details (QuotaFailure e RetryInfo) e, por extenso, na message.
function detalheCota(e, msg) {
  const detalhes = Array.isArray(e.details) ? e.details : [];
  const partes = [];
  for (const v of detalhes.flatMap(d => (d && Array.isArray(d.violations)) ? d.violations : [])) {
    const id = String(v.quotaId || v.quotaMetric || '');
    const periodo = /PerDay|per_day/i.test(id) ? 'por dia' : /PerMinute|per_minute/i.test(id) ? 'por minuto' : '';
    const oQue = /token/i.test(id) ? 'tokens' : 'pedidos';
    const modelo = v.quotaDimensions && v.quotaDimensions.model;
    partes.push(`limite ${periodo || id}${v.quotaValue !== undefined ? ` de ${v.quotaValue} ${oQue}` : ''}${modelo ? ` (${modelo})` : ''}`);
  }
  if (!partes.length) {
    const m = msg.match(/limit: (\d+)(?:, model: ([\w.-]+))?/);
    if (m) partes.push(`limite de ${m[1]}${m[2] ? ` (${m[2]})` : ''}`);
  }
  const espera = (detalhes.find(d => d && d.retryDelay) || {}).retryDelay || (msg.match(/retry in ([\d.]+s)/i) || [])[1];
  if (espera) partes.push(`o Google pede para esperar ${String(espera).replace(/\.\d+/, '')}`);
  return [...new Set(partes)].join('; ');
}

// Resposta do nó HTTP do Gemini -> null (deu certo) ou { codigo, tipo, detalhe }
function erroGemini(resp) {
  const e = resp && resp.error;
  if (!e) return null;
  const msg = String(typeof e === 'string' ? e : (e.message || JSON.stringify(e)));
  // O nó HTTP do n8n troca a message do 429 por uma dica de batching ("Try spacing your
  // requests out...") e deixa o código no statusCode (o httpCode é do NodeApiError, e
  // code/status do AxiosError vêm como texto, que não vira número)
  const codigo = Number((msg.match(/^\s*(\d{3})\b/) || [])[1] || e.httpCode || e.statusCode || e.code || e.status || 0) || 0;
  let tipo = 'outro';
  // "billing" sozinho não basta: o 429 de cota do Google também diz "check your plan and billing details"
  if (codigo === 402 || /prepay|credits? (are )?depleted/i.test(msg) || (codigo !== 429 && /billing/i.test(msg))) tipo = 'cobranca';
  else if (codigo === 429 || /RESOURCE_EXHAUSTED|quota|too many requests|try spacing your requests out/i.test(msg)) tipo = 'cota';
  else if (codigo === 401 || codigo === 403 || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(msg)) tipo = 'chave';
  else if ([500, 502, 503, 504].includes(codigo) || /overloaded|high demand|UNAVAILABLE/i.test(msg)) tipo = 'sobrecarga';
  // Só a frase do Google, sem o JSON em volta (vem escapado dentro da mensagem do n8n).
  // No 429 embrulhado pelo n8n, a frase do Google, quando sobra, está no corpo da resposta
  let corpo = e.response && (e.response.data !== undefined ? e.response.data : e.response.body);
  if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo); } catch (x) { corpo = null; } }
  const doGoogle = corpo && corpo.error && typeof corpo.error.message === 'string' ? corpo.error.message : '';
  const frase = doGoogle || (msg.replace(/\\+"/g, '"').match(/"message":\s*"([^"]{5,200})/) || [])[1] || msg;
  const cota = tipo === 'cota' && typeof e === 'object' ? detalheCota(e, msg) : '';
  return { codigo, tipo, detalhe: cota ? cortar(cota, 300) : cortar(frase.replace(/\\n/g, ' ').trim(), 160) };
}

// O que dizer no Telegram para cada tipo de erro (HTML do Telegram)
const ORIENTACAO = {
  cobranca: 'Os créditos do projeto do Google ligado à chave do Gemini acabaram. Para seguir sem pagar, crie uma chave ' +
    'num projeto <b>sem faturamento</b> em aistudio.google.com e rode no servidor: ' +
    '<code>bash servidor/configurar_n8n.sh --trocar --faturamento nao</code>',
  cota: 'A cota do Gemini acabou em todos os modelos da lista (modelo_gemini e modelos_reserva). No plano gratuito ela ' +
    'volta sozinha (por minuto e por dia). Se acontecer sempre, inclua outro modelo em modelos_reserva ou deixe o ' +
    'filtro_titulo mais rigoroso (menos vagas para analisar).',
  chave: 'A chave do Gemini foi recusada (errada, apagada ou sem permissão). Crie outra em aistudio.google.com e rode no ' +
    'servidor: <code>bash servidor/configurar_n8n.sh --trocar</code>',
  sobrecarga: 'O Gemini está sobrecarregado em todos os modelos da lista. Costuma passar sozinho; não precisa fazer nada.',
  outro: 'Erro inesperado do Gemini. Se repetir, veja a execução no n8n ou rode <code>bash servidor/diagnostico.sh</code>.',
};
// Erros que não são culpa da vaga: ela volta para a fila sem gastar tentativa
const ERROS_DE_SERVICO = ['cobranca', 'cota', 'chave', 'sobrecarga'];

function escErro(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
