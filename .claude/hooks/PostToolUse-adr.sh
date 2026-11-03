#!/usr/bin/env bash
# PostToolUse-adr.sh — verifica consistência de ADR MA-*.md após edição.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

INPUT="$(read_hook_stdin)"
FILE="$(json_field "$INPUT" "tool_input.file_path")"
[[ -z "$FILE" ]] && exit 0

log_info "ADR editado: $FILE — checando consistência"

if node "$HOOKS_DIR/lib/invoke-skill.js" adr-consistency-check "$FILE"; then
  log_info "adr-consistency-check: OK"
else
  log_warn "adr-consistency-check: divergência detectada — revise contra PRD e ADRs anteriores"
fi

# Lembrete sobre Status
if grep -qiE '^\s*-?\s*\*?\*?Status\*?\*?\s*:?\s*Proposta' "$FILE" 2>/dev/null; then
  log_info "ADR em Proposta — não bloqueia produção até virar Aceita (com carimbo)"
fi

exit 0
