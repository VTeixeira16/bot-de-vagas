#!/usr/bin/env bash
# Mostra as vagas que o bot analisou e NÃO mandou no resumo (nota abaixo do corte), com o
# motivo que o modelo deu, e as que ele não conseguiu ler. Rode na pasta do repositório:
#
#   bash servidor/recusadas.sh            (últimos 7 dias, corte de resumo.nota_minima no config)
#   bash servidor/recusadas.sh 30         (últimos 30 dias)
#   bash servidor/recusadas.sh 30 --csv   (também grava ~/relatorios/recusadas-AAAAMMDD.csv)
#
# O que é descartado antes da análise (estágio/júnior no título, vaga antiga, títulos da
# Remotive fora do filtro) nem entra no banco, então não aparece aqui.
set -euo pipefail
cd "$(dirname "$0")/.."

DIAS=7; CSV=nao
for arg in "$@"; do
  case "$arg" in
    --csv) CSV=sim ;;
    ''|*[!0-9]*) echo "uso: bash servidor/recusadas.sh [dias] [--csv]" >&2; exit 1 ;;
    *) DIAS="$arg" ;;
  esac
done
# Mesmo corte do resumo: resumo.nota_minima do config/config.json (conferido pelo
# configuracao.py); com a configuração errada, vale o padrão e o script avisa.
if ! CORTE="$(python3 -c 'import configuracao; print(configuracao.carregar()[0]["resumo"]["nota_minima"])' 2>/dev/null)"; then
  CORTE="$(python3 -c 'import configuracao; print(configuracao.PADRAO["resumo"]["nota_minima"])')"
  echo "AVISO: a configuração tem erro (veja com: python3 configuracao.py); usando o corte padrão ($CORTE)." >&2
fi
case "$CORTE" in
  ''|*[!0-9.]*) echo "nota de corte inválida: $CORTE" >&2; exit 1 ;;
esac

psql() { docker compose exec -T postgres psql -U vagas -d vagas -v ON_ERROR_STOP=1 "$@"; }

FILTRO="analisado_em > now() - interval '$DIAS days'"

echo "== Abaixo do corte ($CORTE), analisadas nos últimos $DIAS dias =="
psql -P pager=off -c "
SELECT score AS nota, fonte,
       left(titulo, 45) AS titulo, left(empresa, 25) AS empresa,
       analise->>'senioridade' AS senioridade,
       CASE WHEN (analise->>'local_compativel')::boolean IS FALSE THEN 'não' ELSE '' END AS local_ok,
       left(analise->>'resumo', 120) AS motivo,
       left(coalesce((SELECT string_agg(g, '; ') FROM jsonb_array_elements_text(analise->'gaps') g), ''), 120) AS falta,
       link
FROM vagas
WHERE status = 'analisada' AND score < $CORTE AND $FILTRO
ORDER BY score DESC;"

echo "== Não consegui ler (página fora do ar ou erro do Gemini) =="
psql -P pager=off -c "
SELECT status, tentativas, left(titulo, 45) AS titulo, left(analise->>'erro', 80) AS erro, link
FROM vagas
WHERE status IN ('erro_fetch', 'erro_llm') AND (analisado_em IS NULL OR $FILTRO)
ORDER BY coletado_em DESC;"

echo "== Situação geral =="
psql -P pager=off -c "
SELECT fonte,
       count(*) AS total,
       count(*) FILTER (WHERE status = 'pendente') AS pendentes,
       count(*) FILTER (WHERE status = 'analisada' AND score >= $CORTE) AS acima_do_corte,
       count(*) FILTER (WHERE status = 'analisada' AND score < $CORTE) AS abaixo,
       count(*) FILTER (WHERE status = 'duplicada') AS duplicadas,
       count(*) FILTER (WHERE status = 'descartada') AS fora_do_filtro,
       count(*) FILTER (WHERE status IN ('erro_fetch', 'erro_llm')) AS erros,
       max(coletado_em)::timestamp(0) AS ultima_coleta
FROM vagas GROUP BY fonte ORDER BY fonte;"

if [ "$CSV" = sim ]; then
  # Planilha só para este usuário (tem dados da sua busca de emprego)
  umask 077
  mkdir -p ~/relatorios
  ARQ=~/relatorios/recusadas-$(date +%Y%m%d).csv
  # Texto que vem dos sites ou do modelo e começa com = + - @ vira fórmula no Excel ao
  # abrir o CSV (CSV injection): ganha um apóstrofo na frente.
  t() { printf '%s' "regexp_replace(coalesce($1, ''), '^([=+@\t\r-])', '''\1')"; }
  psql -c "COPY (
    SELECT score AS nota, fonte, $(t titulo) AS titulo, $(t empresa) AS empresa, $(t local) AS local,
           analise->>'categoria' AS categoria,
           analise->>'senioridade' AS senioridade, analise->>'modelo_trabalho' AS modelo,
           analise->>'local_compativel' AS local_compativel, $(t "analise->>'resumo'") AS motivo,
           $(t "(SELECT string_agg(a, '; ') FROM jsonb_array_elements_text(analise->'atende') a)") AS atende,
           $(t "(SELECT string_agg(g, '; ') FROM jsonb_array_elements_text(analise->'gaps') g)") AS falta,
           $(t link) AS link, analisado_em
    FROM vagas WHERE status = 'analisada' AND score < $CORTE AND $FILTRO ORDER BY score DESC
  ) TO STDOUT WITH (FORMAT csv, HEADER, ENCODING 'UTF8')" > "$ARQ"
  echo "CSV: $ARQ (no Windows: scp vagas:$ARQ .)"
fi
