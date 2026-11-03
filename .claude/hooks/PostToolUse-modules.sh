#!/usr/bin/env bash
# PostToolUse-modules.sh — verifica estrutura padrão de módulo em src/modules/<X>/.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

INPUT="$(read_hook_stdin)"
FILE="$(json_field "$INPUT" "tool_input.file_path")"
[[ -z "$FILE" ]] && exit 0

# Normaliza e extrai diretório do módulo
FILE_NORM=$(echo "$FILE" | tr '\\' '/')
MOD_DIR=$(echo "$FILE_NORM" | sed -n 's|.*\(src/modules/[^/]*\).*|\1|p')
[[ -z "$MOD_DIR" ]] && exit 0

# Caminho absoluto
ABS_MOD_DIR="$PROJECT_ROOT/$MOD_DIR"
[[ -d "$ABS_MOD_DIR" ]] || exit 0

MOD_NAME=$(basename "$MOD_DIR")
log_info "Módulo tocado: $MOD_NAME — verificando estrutura padrão"

# Estrutura esperada (§8.5 CLAUDE.md): index/routes/service/repository/schemas/types
EXPECTED=(index.ts routes.ts service.ts repository.ts schemas.ts types.ts)
missing=()
for f in "${EXPECTED[@]}"; do
  [[ -f "$ABS_MOD_DIR/$f" ]] || missing+=("$f")
done

if (( ${#missing[@]} > 0 )); then
  log_warn "Módulo '$MOD_NAME' incompleto. Faltando: ${missing[*]}"
  log_warn "Estrutura padrão (CLAUDE.md §8.5): index.ts, routes.ts, service.ts, repository.ts, schemas.ts, types.ts"
else
  log_info "Módulo '$MOD_NAME': estrutura padrão OK"
fi

exit 0
