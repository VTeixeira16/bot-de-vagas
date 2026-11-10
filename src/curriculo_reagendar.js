// Nó "Currículo: tentar mais tarde?" — se todos os modelos estiverem sobrecarregados (ou sem
// cota) agora, não desiste: avisa no Telegram e o nó "Currículo: esperar" segura o pedido por
// alguns minutos antes de voltar à 1ª tentativa (o n8n guarda a execução enquanto espera).
// Depois da última espera, ou com outro erro, segue para o "Currículo: interpretar".
const ESPERAS_MIN = [2, 5, 10];

function main(item) {
  const v = item || {};
  const e = v.erro_gemini;
  const rodada = Number(v._rodada || 0);
  if (e && ['sobrecarga', 'cota'].includes(e.tipo) && v.llm_body && rodada < ESPERAS_MIN.length) {
    const min = ESPERAS_MIN[rodada];
    const estado = e.tipo === 'cota' ? 'sem cota' : 'sobrecarregado';
    return [{ json: { ...v, _rodada: rodada + 1, _tentativa: 0, esperar: true, esperar_min: min,
      texto: `⏳ O Gemini está ${estado} agora (tentei ${MODELOS.join(', ')}). Tento de novo sozinho em ${min} min ` +
        `(nova tentativa ${rodada + 1} de ${ESPERAS_MIN.length}); não precisa mandar o PDF de novo.` } }];
  }
  const { llm_body, ...resto } = v;
  return [{ json: { ...resto, esperar: false } }];
}
