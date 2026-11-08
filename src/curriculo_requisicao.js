// Nó "Currículo: montar pedido" — o PDF do currículo (baixado do Telegram pelo
// servidor/telegram_comandos.py e entregue em base64) vai para o Gemini junto com o perfil
// em uso hoje (para manter as preferências) e a legenda que você escreveu. PERFIL (o do
// config/perfil.md) e PROMPT_CURRICULO (prompt_curriculo.md) são injetados pelo build.py.
const SCHEMA_CURRICULO = {
  type: 'OBJECT',
  properties: {
    e_curriculo: { type: 'BOOLEAN' },
    avisos: { type: 'ARRAY', items: { type: 'STRING' } },
    perfil: { type: 'STRING' },
  },
  required: ['e_curriculo', 'avisos', 'perfil'],
  propertyOrdering: ['e_curriculo', 'avisos', 'perfil'],
};

// comando: o que o webhook recebeu ({ body: { texto, legenda, arquivo } });
// emUso: a linha do "Perfil em uso (currículo)" (perfil enviado antes pelo Telegram, se houver)
function main(comando, emUso) {
  const corpo = (comando && comando.body) || comando || {};
  const arquivo = corpo.arquivo || {};
  const perfilAtual = (emUso && emUso.perfil) || PERFIL;
  const legenda = String(corpo.legenda || '').trim();
  return [{
    json: {
      modelo: MODELO,
      origem: cortar(arquivo.nome || 'curriculo.pdf', 120),
      llm_body: {
        systemInstruction: { parts: [{ text: PROMPT_CURRICULO }] },
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'application/pdf', data: String(arquivo.base64 || '') } },
            { text: `=== PERFIL ATUAL ===\n${perfilAtual}\n\n=== OBSERVAÇÕES DO CANDIDATO ===\n${legenda || '(nenhuma)'}` },
          ],
        }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SCHEMA_CURRICULO },
      },
    },
  }];
}
