// Erros do Gemini: o que cada um quer dizer e o que fazer. Usado pelo "... conferir
// resposta" (decide se tenta o próximo modelo), pelo aviso no Telegram e pelo currículo.
// Modelos na ordem de tentativa: o modelo_gemini e depois os modelos_reserva (config.json).
const MODELOS = [CONFIG.modelo_gemini, ...CONFIG.modelos_reserva.filter(m => m !== CONFIG.modelo_gemini)];
// Cota do modelo (429) e sobrecarga (5xx): outro modelo pode responder
const RETENTAVEIS = [429, 500, 502, 503, 504];

// Resposta do nó HTTP do Gemini -> null (deu certo) ou { codigo, tipo, detalhe }
function erroGemini(resp) {
  const e = resp && resp.error;
  if (!e) return null;
  const msg = String(typeof e === 'string' ? e : (e.message || JSON.stringify(e)));
  const codigo = Number((msg.match(/^\s*(\d{3})\b/) || [])[1] || e.httpCode || e.code || e.status || 0) || 0;
  let tipo = 'outro';
  if (codigo === 402 || /prepay|credits? (are )?depleted|billing/i.test(msg)) tipo = 'cobranca';
  else if (codigo === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) tipo = 'cota';
  else if (codigo === 401 || codigo === 403 || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(msg)) tipo = 'chave';
  else if ([500, 502, 503, 504].includes(codigo) || /overloaded|high demand|UNAVAILABLE/i.test(msg)) tipo = 'sobrecarga';
  // Só a frase do Google, sem o JSON em volta (vem escapado dentro da mensagem do n8n)
  const frase = (msg.replace(/\\+"/g, '"').match(/"message":\s*"([^"]{5,200})/) || [])[1] || msg;
  return { codigo, tipo, detalhe: cortar(frase.replace(/\\n/g, ' ').trim(), 160) };
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
