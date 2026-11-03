---
description: Orquestra o workflow §8.2 do CLAUDE.md (nova migration Drizzle) invocando o agent migration-author.
---

# /new-migration

Gera nova migration via `drizzle-kit`, revisa SQL produzido e atualiza schema TS correspondente.

## Argumentos

Um input obrigatório:

1. **Nome curto**: descrição em snake_case, sem prefixo de timestamp (drizzle-kit adiciona). Ex.: `add_waba_connections_state_index`, `soft_delete_templates`, `audit_log_partition_prep`.

Uso típico:

```
/new-migration
nome: add_waba_connections_state_index
```

## O que faz

1. Valida o nome (snake_case, ≤ 60 chars, sem espaços).
2. Carrega contexto: PRD §8 (modelo de dados, 15 entidades), `db/schema/*.ts`, MA-001 (stack travada — Drizzle + Postgres 16).
3. Invoca o agent **`migration-author`** passando o nome + intent inferido do nome ou perguntado ao usuário se ambíguo.
4. Agent edita `db/schema/<arquivo>.ts` conforme intent, roda `pnpm drizzle-kit generate --name=<nome>`, lê o SQL gerado em `db/migrations/`, valida.
5. Aplica checklist crítico:
   - Coluna nova: tem default ou é nullable? (não pode travar migration em prod com dados existentes)
   - Mudança de tipo: requer confirmação humana (§13).
   - Drop de coluna: exige duas migrations (deprecate → drop em release seguinte).
   - Index novo: usar `CONCURRENTLY` se a tabela já tem volume.
6. Reporta: arquivo de schema tocado, SQL gerado, riscos detectados, comando para aplicar (`pnpm migrate:up`).

## Não-faz

- Não roda `pnpm migrate:up` automaticamente. Decisão do humano.
- Não escreve SQL à mão. Sempre via `drizzle-kit generate`. Exceção exige comentário no arquivo de migration + justificativa no PR.
- Não toca dados (sem `UPDATE`/`INSERT` em migration sem confirmação explícita).
