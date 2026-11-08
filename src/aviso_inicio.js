// Nó "Aviso: montar mensagem" — mensagem no Telegram quando o bot liga: n8n (re)iniciado
// (ex.: servidor reiniciado, atualização) ou workflow publicado. Recebe a situação do banco.
// O comando /status usa o mesmo código (nó "Status: montar mensagem").
const MOTIVO = {
  'Instance started': 'o n8n foi (re)iniciado',
  'Workflow published': 'o workflow foi publicado',
  'Workflow updated': 'o workflow foi atualizado',
  'Manual execution': 'teste manual',
  status: 'você pediu /status',
};

function fmtData(iso) {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function main(evento, situacao) {
  const ev = (evento && evento.event) || '';
  const s = situacao || {};
  const n = (v) => Number(v || 0);
  const linhas = [
    '🟢 <b>Bot de vagas no ar</b>',
    `Motivo: ${esc(MOTIVO[ev] || ev || 'início')}`,
    '',
    `⏰ Coleta ${CONFIG.horarios.coleta.join(' e ')} · análise ${CONFIG.horarios.analise} · resumo ${CONFIG.horarios.resumo}`,
    '💬 Comandos: /vagas /buscar /recentes /status /perfil /ajuda · PDF do currículo: mande aqui',
  ];
  if (s.total !== undefined) {
    linhas.push(
      `🗂️ ${n(s.total)} vagas no banco · ${n(s.pendentes)} aguardando análise · ${n(s.a_notificar)} para o próximo resumo`,
      `Última coleta: ${fmtData(s.ultima_coleta)} · última análise: ${fmtData(s.ultima_analise)}`,
    );
  } else {
    linhas.push('⚠️ Não consegui ler o banco: confira a credencial do Postgres.');
  }
  return [{ json: { texto: linhas.join('\n') } }];
}

function esc(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
