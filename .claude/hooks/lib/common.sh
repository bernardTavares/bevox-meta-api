#!/usr/bin/env bash
# .claude/hooks/lib/common.sh — helpers compartilhados pelos hooks do bevox-meta-api.
# Source-once guard.
if [[ "${__BEVOX_META_API_COMMON_LOADED:-}" == "1" ]]; then
  return 0 2>/dev/null || true
fi
__BEVOX_META_API_COMMON_LOADED=1

set -euo pipefail

# PROJECT_ROOT: dois níveis acima de lib/ (lib -> hooks -> .claude -> root)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HOOKS_DIR="$PROJECT_ROOT/.claude/hooks"
STATE_DIR="$PROJECT_ROOT/.claude/state"

log_info()  { printf '[hook] %s\n' "$*" >&2; }
log_warn()  { printf '[hook WARN] %s\n' "$*" >&2; }
log_error() { printf '[hook ERROR] %s\n' "$*" >&2; }

block() {
  local msg="$1"
  printf '\n[BLOCKED] %s\n\n' "$msg" >&2
  exit 2
}

warn_only() {
  local msg="$1"
  printf '\n[WARN] %s\n\n' "$msg" >&2
  return 0
}

# Lê stdin JSON do Claude Code se disponível (sem travar).
read_hook_stdin() {
  if [[ ! -t 0 ]]; then
    cat
  else
    echo ""
  fi
}

# Extrai campo de JSON via node (sem jq obrigatório).
json_field() {
  local json="$1"
  local field="$2"
  node -e "try{const d=JSON.parse(process.argv[1]||'{}');const p='$field'.split('.');let v=d;for(const k of p){v=v?.[k]}process.stdout.write(v??'')}catch(e){}" "$json" 2>/dev/null || true
}
