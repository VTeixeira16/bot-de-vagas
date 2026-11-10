// Nó "... tentativa" — escolhe o modelo de cada pedido ao Gemini: na 1ª tentativa o
// modelo_gemini; se ele responder cota estourada (429) ou sobrecarga (5xx), o "... conferir
// resposta" devolve o pedido para cá com _tentativa + 1, e vai o próximo de modelos_reserva.
function main(items) {
  return items.map(item => {
    const t = Number(item.json._tentativa || 0);
    return { json: { ...item.json, _tentativa: t, modelo: MODELOS[Math.min(t, MODELOS.length - 1)] } };
  });
}
