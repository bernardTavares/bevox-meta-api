#!/usr/bin/env bash
# PreToolUse-guard.sh — bloqueia operações destrutivas e edição de docs/migrations carimbadas.
# Lê stdin JSON do Claude Code. Sai 0 (permitir) ou 2 (bloquear) com mensagem em stderr.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

INPUT="$(read_hook_stdin)"
TOOL="$(json_field "$INPUT" "tool_name")"
[[ -z "$TOOL" ]] && TOOL="$(json_field "$INPUT" "tool")"

# Bash: bloqueia rm destrutivo em paths sensíveis + comandos git destrutivos.
if [[ "$TOOL" == "Bash" ]]; then
  CMD="$(json_field "$INPUT" "tool_input.command")"
  [[ -z "$CMD" ]] && CMD="$(json_field "$INPUT" "input.command")"
  CMD_LC=$(echo "$CMD" | tr '[:upper:]' '[:lower:]')

  # rm em paths protegidos
  if [[ "$CMD_LC" =~ rm[[:space:]].*(prds/|docs/adr/ma-00[1-8]|db/migrations/|\.env) ]]; then
    block "rm em path protegido (prds/, ADRs MA-001..MA-008, db/migrations/, .env*). Use Edit/Write em arquivos não-carimbados ou abra ADR superseding."
  fi

  # comandos git destrutivos
  if [[ "$CMD_LC" =~ git[[:space:]]+push[[:space:]]+(--force|-f) ]]; then
    block "git push --force/-f desabilitado. Use rebase + push normal ou peça aprovação explícita."
  fi
  if [[ "$CMD_LC" =~ git[[:space:]]+reset[[:space:]]+--hard ]]; then
    block "git reset --hard desabilitado. Use 'git stash' ou 'git restore' direcionado."
  fi
  if [[ "$CMD_LC" =~ git[[:space:]]+clean[[:space:]]+-fdx ]]; then
    block "git clean -fdx desabilitado. Liste o que quer remover manualmente."
  fi

  # pnpm install <pacote> sem ADR — apenas warn (§13 CLAUDE.md)
  if [[ "$CMD_LC" =~ ^[[:space:]]*pnpm[[:space:]]+(add|install)[[:space:]]+[a-z@] ]]; then
    if [[ ! "$CMD_LC" =~ pnpm[[:space:]]+install[[:space:]]*$ ]]; then
      warn_only "Adicionando dependência via pnpm. CLAUDE.md §13: nova dep exige listar alternativas + justificar (ADR se trocar provider externo)."
    fi
  fi

  exit 0
fi

# Edit/Write: bloqueia paths protegidos.
if [[ "$TOOL" == "Edit" || "$TOOL" == "Write" || "$TOOL" == "MultiEdit" ]]; then
  FILE="$(json_field "$INPUT" "tool_input.file_path")"
  [[ -z "$FILE" ]] && FILE="$(json_field "$INPUT" "tool_input.path")"
  [[ -z "$FILE" ]] && FILE="$(json_field "$INPUT" "input.file_path")"

  # Normaliza separadores Windows
  FILE_NORM=$(echo "$FILE" | tr '\\' '/')

  case "$FILE_NORM" in
    */prds/*|prds/*)
      block "prds/ é fonte canônica V1. Edição requer PR explícito + revisão humana."
      ;;
    */docs/adr/MA-001*|*/docs/adr/MA-002*|*/docs/adr/MA-003*|*/docs/adr/MA-004*|*/docs/adr/MA-005*|*/docs/adr/MA-006*|*/docs/adr/MA-007*|*/docs/adr/MA-008*)
      block "ADRs MA-001..MA-008 estão carimbadas (Aceita). Criar ADR superseding em vez de editar."
      ;;
    */db/migrations/*|db/migrations/*)
      block "Migrations aplicadas não devem ser editadas. Gere nova via 'pnpm migrate:generate --name=<x>'."
      ;;
    */.env|*/.env.local|*/.env.production|.env|.env.local|.env.production)
      block "Arquivos .env não devem ser lidos/editados via Claude. Use .env.example como referência."
      ;;
  esac
fi

exit 0
