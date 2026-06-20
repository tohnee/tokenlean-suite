#!/usr/bin/env bash
# install.sh — verify environment, run tests, print integration next steps.
# tokenlean-mcp has zero dependencies; "install" = check Node + self-test.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "tokenlean-mcp installer"
echo "──────────────────────────────"

# 1. Node >= 18
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Install Node >= 18 first." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node $NODE_MAJOR found; need >= 18." >&2
  exit 1
fi
echo "✓ Node $(node -v)"

# 2. self-test (both transports)
echo
echo "Running self-tests..."
node "$DIR/test/test-stdio.mjs" >/tmp/tl-stdio.log 2>&1 && echo "✓ stdio transport: $(tail -1 /tmp/tl-stdio.log | tr -d '═ ')" || { echo "✗ stdio test failed; see /tmp/tl-stdio.log"; exit 1; }
node "$DIR/test/test-http.mjs"  >/tmp/tl-http.log  2>&1 && echo "✓ http  transport: $(tail -1 /tmp/tl-http.log  | tr -d '═ ')" || { echo "✗ http test failed; see /tmp/tl-http.log"; exit 1; }

# 3. optional symlink onto PATH
echo
if [ "${1:-}" = "--link" ]; then
  TARGET="/usr/local/bin/tokenlean"
  if ln -sf "$DIR/tokenlean.mjs" "$TARGET" 2>/dev/null; then
    chmod +x "$DIR/tokenlean.mjs"
    echo "✓ linked: $TARGET → tokenlean.mjs   (run: tokenlean help)"
  else
    echo "⚠ could not write $TARGET (try: sudo $0 --link). Use 'node $DIR/tokenlean.mjs' instead."
  fi
fi

cat <<EOF

Done. Next steps:

  LOCAL CLI form (Claude Code / OpenCode / Codex / Cursor):
    See $DIR/configs/  — copy the MCP json for your agent.
    Quick check:  node $DIR/tokenlean.mjs stdio --root .

  WEB COPILOT form (Claude.ai connector / chatbot):
    TOKENLEAN_TOKEN=\$(openssl rand -hex 16) node $DIR/tokenlean.mjs http --root /path/to/repo
    Then expose via tunnel:  cloudflared tunnel --url http://127.0.0.1:8765
    See $DIR/configs/chatbot.md

EOF
