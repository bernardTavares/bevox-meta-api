#!/usr/bin/env bash
# PreCompact.sh — snapshot do estado antes da compactação de contexto.
# NÃO inclui conteúdo de .env, src/lib/crypto-envelope.ts, ou tokens.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

mkdir -p "$STATE_DIR"
SNAPSHOT="$STATE_DIR/last-session.md"

cd "$PROJECT_ROOT" 2>/dev/null || true

{
  echo "# Last Session — bevox-meta-api"
  echo ""
  echo "Snapshot: $(date -Iseconds 2>/dev/null || date)"
  echo ""
  echo "## Branch atual"
  git branch --show-current 2>/dev/null || true
  echo ""
  echo "## Working tree status"
  git status --short 2>/dev/null || true
  echo ""
  echo "## Últimos 5 commits"
  git log --oneline -5 2>/dev/null || true
  echo ""
  echo "## Tasks in-progress (TaskMaster)"
  if command -v task-master >/dev/null 2>&1; then
    task-master list --status=in-progress 2>/dev/null | head -30 || echo "(nenhuma)"
  else
    echo "(CLI task-master indisponível)"
  fi
  echo ""
  echo "## ADRs em Proposta"
  if [[ -d "docs/adr" ]]; then
    for f in docs/adr/MA-*.md; do
      [[ -f "$f" ]] || continue
      if grep -qiE '^\s*-?\s*\*?\*?Status\*?\*?\s*:?\s*Proposta' "$f" 2>/dev/null; then
        echo "- $f"
      fi
    done
  fi
  echo ""
  echo "## Arquivos modificados vs main"
  last_main=$(git merge-base HEAD main 2>/dev/null || echo "")
  if [[ -n "$last_main" ]]; then
    git diff --name-only "$last_main"..HEAD 2>/dev/null | head -30 || true
  fi
  echo ""
  echo "---"
  echo "Política: este snapshot NÃO inclui conteúdo de .env*, src/lib/crypto-envelope.ts,"
  echo "nem nenhum output que possa carregar tokens ou messages.content."
} > "$SNAPSHOT"

log_info "Snapshot salvo em $SNAPSHOT"
