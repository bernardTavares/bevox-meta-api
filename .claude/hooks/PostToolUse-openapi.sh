#!/usr/bin/env bash
# PostToolUse-openapi.sh — valida openapi.yaml após edição.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

INPUT="$(read_hook_stdin)"
FILE="$(json_field "$INPUT" "tool_input.file_path")"
[[ -z "$FILE" ]] && FILE="docs/architecture/openapi.yaml"

log_info "openapi.yaml editado — rodando validação de contrato"

if node "$HOOKS_DIR/lib/invoke-skill.js" openapi-contract-validate "$FILE"; then
  log_info "openapi-contract-validate: OK"
else
  log_warn "openapi-contract-validate: falhou — revise antes de commitar"
fi

# Lembrete: se mudou contrato, rodar gen de tipos
log_info "Lembrete: 'pnpm openapi:types' regenera src/types/api.ts a partir do YAML"

exit 0
