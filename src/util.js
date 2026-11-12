// Funções compartilhadas. O build.py copia este arquivo para dentro de cada nó Code, logo
// depois da constante CONFIG (o config.json já conferido e com os padrões; ver configuracao.py).
const MODELO = CONFIG.modelo_gemini;
const DIAS_RECENTES = 3; // ignora vagas publicadas há mais tempo (Gupy/Remotive)
// Coleta retroativa (/sim à pergunta do banco vazio, ou /buscar 30): últimos 30 dias.
const DIAS_RETROATIVO = 30;
// Os sites de vagas recusam pedidos sem cara de navegador
const UA_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodificar(txt) {
  return String(txt || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, e) => (e.toLowerCase() in ENTIDADES ? ENTIDADES[e.toLowerCase()] : m));
}

// Páginas maiores que isto são cortadas antes de qualquer regex: o texto útil de uma vaga
// cabe com folga, e um HTML gigante (ou feito para isso) não trava o nó.
const MAX_HTML = 1500000;

// Tira <script>, <style>, <head>, <noscript> e comentários em uma passada (indexOf, sem
// regex com volta atrás). A regex antiga levava dezenas de segundos com muitas tags abertas
// sem fechamento.
function semBlocos(html) {
  const s = String(html || '').slice(0, MAX_HTML);
  const baixo = s.toLowerCase();
  const abre = /<!--|<(script|style|head|noscript)\b/g;
  let saida = '';
  let pos = 0;
  let m;
  while ((m = abre.exec(baixo))) {
    const fecha = m[0] === '<!--' ? '-->' : `</${m[1]}`;
    const fim = baixo.indexOf(fecha, abre.lastIndex);
    if (fim < 0) break; // sem fechamento: o resto fica como está (as tags somem depois)
    saida += s.slice(pos, m.index) + ' ';
    pos = m[0] === '<!--' ? fim + 3 : (baixo.indexOf('>', fim) + 1 || baixo.length);
    abre.lastIndex = pos;
  }
  return saida + s.slice(pos);
}

// HTML -> texto legível. Com manterLinks, <a href="x">y</a> vira "y [x]".
function htmlParaTexto(html, manterLinks = false) {
  let s = semBlocos(html);
  if (manterLinks) {
    // Quantificadores limitados: com [^>]* uma tag sem ">" faria a regex varrer o resto da
    // página a cada "<" (tempo quadrático).
    s = s.replace(/<a\b[^>]{0,1000}href=["']([^"']{1,2000})["'][^>]{0,1000}>([\s\S]{0,5000}?)<\/a>/gi,
      (_, href, txt) => ` ${txt} [${decodificar(href)}] `);
  }
  s = s
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\b[^>]{0,1000}>/gi, '\n')
    .replace(/<li\b[^>]{0,1000}>/gi, '\n- ')
    .replace(/<[^>]{1,1000}>/g, ' ');
  return decodificar(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Termos do config.json, comparados sem acento e sem maiúsculas: "ti" só vale como palavra
// inteira; "coordena*" vale para qualquer palavra que comece assim (coordenador, coordenação).
function termoComparavel(termo) {
  const s = String(termo || '').trim();
  const prefixo = s.endsWith('*');
  return { n: normalizarChave(prefixo ? s.slice(0, -1) : s), prefixo };
}
function temTermo(texto, termos) {
  const t = ` ${normalizarChave(texto)} `;
  return (termos || []).some(termo => {
    const { n, prefixo } = termoComparavel(termo);
    return !!n && t.includes(` ${n}${prefixo ? '' : ' '}`);
  });
}
function comecaComTermo(texto, termos) {
  const t = `${normalizarChave(texto)} `;
  return (termos || []).some(termo => {
    const { n, prefixo } = termoComparavel(termo);
    return !!n && t.startsWith(`${n}${prefixo ? '' : ' '}`);
  });
}

// Títulos que nunca interessam (descartar_titulos no config.json): evita gastar chamada de LLM com eles.
function tituloDescartavel(titulo) {
  const d = CONFIG.descartar_titulos;
  return temTermo(titulo, d.com) || comecaComTermo(titulo, d.comecando_com);
}

function recente(dataIso, dias = DIAS_RECENTES) {
  if (!dataIso) return true;
  const t = Date.parse(dataIso);
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= dias * 86400000;
}

function cortar(txt, max) {
  txt = String(txt || '');
  return txt.length > max ? txt.slice(0, max) + '…' : txt;
}

function normalizarChave(txt) {
  return String(txt || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function textoResposta(resp) {
  const parts = resp && resp.candidates && resp.candidates[0] && resp.candidates[0].content
    && resp.candidates[0].content.parts;
  if (!parts) return null;
  return parts.map(p => p.text || '').join('');
}
