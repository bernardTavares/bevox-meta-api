---
description: Mostra a próxima task TaskMaster pronta, carrega contexto de PRD/ADRs relacionados e propõe plano de implementação. Não escreve código.
---

# /next-task

Read-only. Não modifica arquivos. Não invoca agents de escrita.

## O que faz

1. Roda `task-master next` para identificar a próxima task `ready` no `.taskmaster/tasks/tasks.json`.
2. Roda `task-master show <id>` com o id retornado e exibe título, descrição, dependencies, testStrategy.
3. Identifica seções relevantes do PRD V1 (`prds/bevox-meta-api-prd-v1.md`) e ADRs (`docs/adr/MA-*.md`) referenciadas pela task — usa Grep por keywords da descrição (ex.: "webhook delivery" → MA-005 §3; "idempotência" → MA-006; "tokens" → MA-008).
4. Lê os trechos identificados (apenas as seções, não os arquivos inteiros) e resume em 3-5 bullets.
5. Propõe um plano de implementação numerado seguindo §8.1 do CLAUDE.md (schema Zod → repository → service → routes → testes → OpenAPI). Lista quais invariantes (§5) a task toca.
6. Lista questões em aberto que exigiriam ADR novo ou confirmação humana (§13) antes de começar.

## Argumentos

Nenhum. Sempre opera sobre `task-master next`. Se o usuário quer uma task específica, deve usar `task-master show <id>` direto.

## Output

- Cabeçalho com id + título da task.
- Seção "Contexto" com refs PRD/ADR e trechos.
- Seção "Plano" numerado.
- Seção "Invariantes tocadas" (lista de §5.x).
- Seção "Bloqueios / Perguntas" (vazio se nenhum).

Não invoca agents. O usuário decide se aciona `/new-endpoint` ou `/new-migration` em seguida.
