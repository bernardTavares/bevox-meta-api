#!/usr/bin/env bash
# Avisa (não bloqueia) ao editar contrato público.
set -euo pipefail

TARGET="${CLAUDE_TOOL_FILE_PATH:-}"
case "$TARGET" in
  docs/architecture/openapi.yaml|docs/architecture/openapi.yml) ;;
  src/mcp/*|src/bin/mcp-server.ts) ;;
  skills/bevox-meta-api-consumer/*) ;;
  *) exit 0 ;;
esac

last_msg=$(git log -1 --format=%B 2>/dev/null || echo "")
case "$last_msg" in
  *"BREAKING CHANGE"*|*"feat"*"!"*|*"refactor"*"!"*|*"fix"*"!"*) exit 0 ;;
esac

echo "⚠️  Você editou um CONTRATO PÚBLICO: $TARGET"
echo ""
echo "Se for mudança breaking:"
echo "  1. Bumpar versão major no contrato afetado"
echo "  2. Criar ADR documentando"
echo "  3. Commit com 'feat(api)!: ...' ou incluir 'BREAKING CHANGE: ...' no body"
echo ""
echo "Se NÃO for breaking, ignore este aviso."
exit 0
