---
description: Busca contexto canônico em ../bevox-knowledge/ (SoT). Aceita argumento livre e lista arquivos + trechos relevantes.
---

# /sync-knowledge

Consulta o repositório `bevox-knowledge` (SoT canônico, estrutura stage-first conforme ADR-010) para puxar contexto que não está no `bevox-meta-api`. Use quando precisar de ADR compartilhado, PRD de outro produto, ou padrão transversal Bevox.

## Argumentos

Um argumento livre em linguagem natural. Exemplos:

- `puxe ADR-010 do shared`
- `encontre PRDs que falam de meta-api`
- `qual o padrão de logging multi-tenant no grupo`
- `liste ADRs do bevox-knowledge que mencionam KMS`

## O que faz

1. Lê o argumento e extrai keywords + intent (lookup direto vs busca semântica).
2. Verifica que `../bevox-knowledge/` existe. Se não, reporta e pede confirmação do path.
3. **Caso 1 — lookup direto** (usuário menciona ADR/PRD/arquivo por nome ou número):
   - Glob por `**/ADR-<NNN>*.md` ou `**/*<termo>*.md`.
   - Lê o(s) arquivo(s) encontrados e mostra cabeçalho + seção relevante.
4. **Caso 2 — busca semântica** (usuário descreve tópico):
   - Grep recursivo por keywords no `bevox-knowledge/` (case-insensitive).
   - Agrupa por stage (`shared/`, `<produto>/`) conforme estrutura ADR-010.
   - Lista até 10 arquivos com 2-3 linhas de contexto por match.
5. **Caso 3 — descoberta cruzada** ("o que mais fala de X"):
   - Grep em ambos `bevox-knowledge/` e `bevox-PRD-consolidation/` (cwd parent).
   - Lista resultados separados por repositório.
6. Para cada arquivo relevante, mostra: path absoluto, stage/produto, título (primeira linha de markdown), trecho de 5-10 linhas com o match.
7. **Não copia conteúdo** para o `bevox-meta-api`. Apenas referencia. Se o usuário quer trazer algo para cá, esse é um passo separado e explícito (e provavelmente exige ADR — §13).

## Não-faz

- Não modifica arquivos no `bevox-knowledge`. Estritamente read-only.
- Não inventa conteúdo se nada for encontrado. Reporta `nenhum match` e sugere refinar o argumento.
- Não traz arquivos para dentro do `bevox-meta-api` sem confirmação humana.
