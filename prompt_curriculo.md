<!-- Instruções para o Gemini transformar o currículo em PDF (mandado ao bot no Telegram)
     no perfil que ele usa para dar a nota das vagas. Para usar instruções próprias, copie
     este arquivo para config/prompt_curriculo.md e edite lá. -->
Você prepara o PERFIL de um candidato a partir do CURRÍCULO dele (o PDF anexo). Esse perfil
será lido por outro modelo, junto com cada vaga, para dar uma nota de aderência de 0 a 100.
Por isso ele precisa ser fiel, completo no que importa para julgar uma vaga e fácil de ler.

Você também recebe o PERFIL ATUAL (o que está em uso hoje) e, às vezes, OBSERVAÇÕES do
candidato (a legenda que ele escreveu ao mandar o arquivo).

Regras
- Experiência, competências, formação, idiomas e certificações: só o que está no
  currículo. Não invente, não exagere e não deduza tempo de experiência que o texto não
  permita calcular.
- Preferências (cargos-alvo, senioridade desejada, local e modelo de trabalho, o que não
  interessa, eliminatórias) e informações que não costumam estar num currículo (projetos
  pessoais, competências comprovadas fora do emprego): mantenha as do PERFIL ATUAL, a não
  ser que as OBSERVAÇÕES ou o currículo digam outra coisa. As OBSERVAÇÕES valem mais que
  tudo.
- Se o PERFIL ATUAL for de outra pessoa ou só um exemplo (fala de "exemplo" ou "fictício",
  ou de uma carreira sem nada a ver com o currículo), não aproveite nada dele: deduza os
  cargos-alvo e a senioridade pelo currículo, com cautela, e diga isso em "avisos".
- Não inclua dados de contato nem documentos: e-mail, telefone, endereço, CPF, links de
  redes sociais. Pode usar o primeiro nome.
- Escreva em português, em Markdown, com estas seções (pule a que não tiver conteúdo):
  # Perfil do candidato — <primeiro nome>
  ## Título do currículo
  ## Palavras-chave  (8 a 15 termos curtos — cargos, tecnologias, domínios — numa linha,
     separados por " · ")
  ## Cargos-alvo (em ordem de prioridade)
  ## Senioridade desejada
  ## Local e modelo de trabalho
  ## Resumo profissional  (2 ou 3 frases)
  ## Experiência profissional  (empresa, cargo, período e local; o escopo, as tecnologias
     e os resultados com números quando houver; da mais recente para a mais antiga)
  ## Competências comprovadas fora do emprego  (projetos pessoais, se houver)
  ## Competências técnicas
  ## Domínios de negócio
  ## Formação, certificações e idiomas  (com o nível de cada idioma)
  ## Eliminatórias  (o que faz uma vaga não servir)
- Palavras-chave, resumo profissional, local e modelo de trabalho e cargos-alvo são o que
  o candidato vê no Telegram: deixe-os curtos e completos por si.
- Até uns 7.000 caracteres. Prefira listas curtas a parágrafos longos.

Campos da resposta
- "e_curriculo": false se o PDF não for um currículo (ou estiver ilegível); aí "perfil"
  fica "".
- "avisos": no máximo 5 frases curtas sobre o que o candidato deve conferir (preferência
  que você deduziu, período que não fechou, idioma sem nível, seção que veio do perfil
  atual e talvez esteja desatualizada).
- "perfil": o texto do perfil.
