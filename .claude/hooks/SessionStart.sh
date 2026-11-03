#!/usr/bin/env bash
# SessionStart.sh — banner inicial rico para bevox-meta-api.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

cd "$PROJECT_ROOT" 2>/dev/null || true

echo ""
echo "=== bevox-meta-api — sessão iniciada ==="
echo "Data: $(date -Iseconds 2>/dev/null || date)"
echo "Root: $PROJECT_ROOT"

# --- Git ---
branch=$(git branch --show-current 2>/dev/null || echo "?")
last_commit=$(git log -1 --format='%h %s (%cr)' 2>/dev/null || echo "?")
echo ""
echo "Branch: $branch"
echo "Último commit: $last_commit"

ahead_behind=$(git rev-list --left-right --count main...HEAD 2>/dev/null || echo "")
if [[ -n "$ahead_behind" ]]; then
  behind=$(echo "$ahead_behind" | awk '{print $1}')
  ahead=$(echo "$ahead_behind" | awk '{print $2}')
  echo "vs main: $ahead à frente, $behind atrás"
fi

# --- TaskMaster ---
echo ""
if command -v task-master >/dev/null 2>&1; then
  in_prog=$(task-master list --status=in-progress 2>/dev/null | grep -cE '^\s*\[' || echo "0")
  pending=$(task-master list --status=pending 2>/dev/null | grep -cE '^\s*\[' || echo "0")
  echo "TaskMaster: $in_prog em progresso, $pending pendentes"
  if [[ "$in_prog" != "0" ]]; then
    task-master list --status=in-progress 2>/dev/null | head -10 || true
  fi
else
  echo "TaskMaster: CLI não instalada (pnpm add -g task-master-ai)"
fi

# --- ADRs em Proposta ---
echo ""
proposta_adrs=()
if [[ -d "docs/adr" ]]; then
  for f in docs/adr/MA-*.md; do
    [[ -f "$f" ]] || continue
    if grep -qiE '^\s*-?\s*\*?\*?Status\*?\*?\s*:?\s*Proposta' "$f" 2>/dev/null; then
      proposta_adrs+=("$f")
    fi
  done
fi
if (( ${#proposta_adrs[@]} > 0 )); then
  echo "ADRs em Proposta (bloqueiam decisões dependentes):"
  for f in "${proposta_adrs[@]}"; do
    echo "  - $f"
  done
else
  echo "ADRs em Proposta: nenhum"
fi

# --- Runbooks tocados recentemente ---
echo ""
recent_runbooks=$(git log -10 --name-only --pretty=format: -- docs/runbooks/ 2>/dev/null | sort -u | grep -v '^$' | head -5 || true)
if [[ -n "$recent_runbooks" ]]; then
  echo "Runbooks tocados nos últimos 10 commits:"
  echo "$recent_runbooks" | sed 's/^/  - /'
fi

# --- Contratos modificados desde main ---
last_main=$(git merge-base HEAD main 2>/dev/null || echo "")
if [[ -n "$last_main" ]]; then
  changed=$(git diff --name-only "$last_main"..HEAD -- \
    docs/architecture/openapi.yaml \
    src/mcp/ \
    src/bin/mcp-server.ts \
    skills/bevox-meta-api-consumer/ 2>/dev/null || true)
  if [[ -n "$changed" ]]; then
    echo ""
    echo "[!] Contratos públicos modificados desde main:"
    echo "$changed" | sed 's/^/  - /'
    echo "    Rodar 'scripts/sync-contracts.sh' no hub após merge."
  fi
fi

echo ""
echo "Pronto. Lembre: PRD ganha de código; invariantes §5 do CLAUDE.md são não-negociáveis."
echo ""
