#!/usr/bin/env bash
# PostToolUse-secrets-scan.sh — varre arquivo TS editado por padrões de log de segredo/PII.
# Invariante §5.4 + §7.4 CLAUDE.md: tokens Meta e messages.content nunca em log.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

INPUT="$(read_hook_stdin)"
FILE="$(json_field "$INPUT" "tool_input.file_path")"
[[ -z "$FILE" ]] && exit 0

FILE_NORM=$(echo "$FILE" | tr '\\' '/')

# Resolve caminho absoluto se relativo
if [[ "$FILE_NORM" != /* ]] && [[ "$FILE_NORM" != ?:* ]]; then
  FILE_ABS="$PROJECT_ROOT/$FILE_NORM"
else
  FILE_ABS="$FILE_NORM"
fi

[[ -f "$FILE_ABS" ]] || exit 0

# Padrões suspeitos (regex grep -E). Sem false-positive em comentários/helpers redact.
PATTERNS=(
  'console\.log[^;]*\b(token|access_token|private_key|refresh_token|bearer)\b'
  '(req\.log|log|logger)\.(info|debug|warn|error)\([^)]*\b(access_token|private_key_pem|refresh_token)\b'
  '(req\.log|log|logger)\.(info|debug|warn|error)\([^)]*\.content\b'
  '(req\.log|log|logger)\.(info|debug|warn|error)\([^)]*\bidempotency.{0,8}body\b'
  '(req\.log|log|logger)\.(info|debug|warn|error)\([^)]*\bwebhook.{0,15}payload\b'
)

found=0
for pat in "${PATTERNS[@]}"; do
  if grep -nEi "$pat" "$FILE_ABS" 2>/dev/null | grep -v 'redact(' | grep -v '// ok:' >/dev/null; then
    if [[ $found -eq 0 ]]; then
      log_warn "Possível log de segredo/PII em $FILE_NORM:"
      found=1
    fi
    grep -nEi "$pat" "$FILE_ABS" | grep -v 'redact(' | grep -v '// ok:' | sed 's/^/    /' >&2 || true
  fi
done

if [[ $found -eq 1 ]]; then
  log_warn "Invariantes §5.4 e §7.4 (CLAUDE.md): nunca logar access_token, private_key_pem, messages.content, idempotency body, webhook payload."
  log_warn "Use helper redact() ou marque a linha com '// ok: <razão>' se for false-positive."
fi

exit 0
