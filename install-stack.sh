#!/usr/bin/env bash
# install-stack.sh — install the full token-saving stack for coding agents and chatbots.
#
# For CODING AGENTS (Claude Code, OpenCode, Cursor, etc.):
#   1. tokenlean-workflow (skills + hooks) — L3-L4: FUTURE/OUTPUT/INPUT behavioral
#   2. tokenlean-mcp (MCP server)         — L2: OUTPUT safety (hash edits) + FUTURE (bounded tools)
#   3. rtk (Rust Token Killer)             — L3: CLI output compression
#   4. caveman (output compression skill)  — L4: telegraphic output style
#   5. Headroom (API proxy)                — L1: prefix cache + CCR (if desired)
#
# For CHATBOTS (Claude.ai, ChatGPT, self-built):
#   --rag  installs tokenlean-rag (cache-optimized RAG MCP server)
#
# Usage:
#   bash install-stack.sh [--dest DIR] [--no-rtk] [--no-caveman] [--no-headroom] [--rag] [--start] [--port N]
#
# Options:
#   --dest DIR     project directory (default: current dir)
#   --no-rtk       skip rtk installation
#   --no-caveman   skip caveman installation
#   --no-headroom  skip Headroom installation
#   --rag          also install tokenlean-rag (RAG MCP for chatbots)
#   --start        start tokenlean-rag in background after install (implies --rag)
#   --port N       RAG server port (default: 8766, only used with --start)
#   --only-tokenlean  only install tokenlean components (skip all external)
#   --help         show this message

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$(pwd)"
INSTALL_RTK=1
INSTALL_CAVEMAN=1
INSTALL_HEADROOM=0  # Headroom is opt-in (needs API key config)
INSTALL_RAG=0       # RAG server for chatbots
START_RAG=0         # auto-start RAG server after install
RAG_PORT=8766       # default RAG server port

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; mkdir -p "$DEST"; shift 2;;
    --no-rtk) INSTALL_RTK=0; shift;;
    --no-caveman) INSTALL_CAVEMAN=0; shift;;
    --no-headroom) INSTALL_HEADROOM=0; shift;;
    --with-headroom) INSTALL_HEADROOM=1; shift;;
    --rag) INSTALL_RAG=1; shift;;
    --start) START_RAG=1; INSTALL_RAG=1; shift;;
    --port) RAG_PORT="$2"; shift 2;;
    --only-tokenlean) INSTALL_RTK=0; INSTALL_CAVEMAN=0; INSTALL_HEADROOM=0; INSTALL_RAG=0; shift;;
    -h|--help) sed -n '2,27p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 1;;
  esac
done

echo "╔════════════════════════════════════════════════════════╗"
echo "║  TokenLean Stack Installer                            ║"
echo "║  Full token-saving pipeline for coding agents          ║"
echo "╚════════════════════════════════════════════════════════╝"
echo "  Project: $DEST"
echo ""

# ── Prerequisites ──
echo "── Checking prerequisites ──"
HAS_NODE=0; command -v node >/dev/null 2>&1 && HAS_NODE=1
HAS_CARGO=0; command -v cargo >/dev/null 2>&1 && HAS_CARGO=1
HAS_NPM=0; command -v npm >/dev/null 2>&1 && HAS_NPM=1
echo "  node: $([ "$HAS_NODE" = 1 ] && echo ✓ || echo ✗)"
echo "  cargo: $([ "$HAS_CARGO" = 1 ] && echo ✓ || echo ✗)"
echo "  npm: $([ "$HAS_NPM" = 1 ] && echo ✓ || echo ✗)"
echo ""

# ── Step 1: tokenlean-workflow ──
echo "══ Step 1/5: tokenlean-workflow (skills + hooks) ══"
if [ -f "$SRC/01-workflow/install.sh" ]; then
  (cd "$DEST" && bash "$SRC/01-workflow/install.sh") && echo "  ✓ workflow installed"
else
  echo "  ⚠ install.sh not found at $SRC/01-workflow/install.sh"
fi
echo ""

# ── Step 2: tokenlean-mcp ──
echo "══ Step 2/5: tokenlean-mcp (MCP server) ══"
MCP_DIR="$SRC/02-mcp-server"
if [ -f "$MCP_DIR/package.json" ]; then
  (cd "$MCP_DIR" && npm install --silent 2>/dev/null) && echo "  ✓ MCP dependencies installed"
  echo "  ✓ MCP server ready at: $MCP_DIR/tokenlean.mjs"
  echo "  To add to Claude Code, add to .mcp.json:"
  echo '    {"mcpServers":{"tokenlean":{"command":"node","args":["'"$MCP_DIR/tokenlean.mjs"'","stdio","--root","'"$DEST"'"]}}}'
else
  echo "  ⚠ MCP server directory not found"
fi
echo ""

# ── Step 3: rtk (Rust Token Killer) ──
if [ "$INSTALL_RTK" = 1 ]; then
  echo "══ Step 3/5: rtk — Rust Token Killer ══"
  if [ "$HAS_CARGO" = 1 ]; then
    echo "  Installing rtk from source (cargo)..."
    if [ -d /tmp/rtk-install ]; then rm -rf /tmp/rtk-install; fi
    git clone --depth 1 https://github.com/azat-io/rtk.git /tmp/rtk-install 2>/dev/null || true
    if [ -d /tmp/rtk-install ]; then
      cd /tmp/rtk-install && cargo install --path . 2>/dev/null && echo "  ✓ rtk installed (cargo)" || echo "  ⚠ rtk cargo install failed — try manual install"
      rm -rf /tmp/rtk-install
    else
      echo "  ⚠ Could not clone rtk. Install manually:"
      echo "     git clone https://github.com/azat-io/rtk.git"
      echo "     cd rtk && cargo install --path ."
    fi
    cd "$DEST"
    echo ""
    echo "  Usage: rtk -- claude"
    echo "  (wrap your agent command: rtk -- claude code, rtk -- opencode, etc.)"
  else
    echo "  ⚠ cargo not found. Install rtk manually from:"
    echo "     https://github.com/azat-io/rtk"
  fi
else
  echo "══ Step 3/5: rtk — skipped ══"
fi
echo ""

# ── Step 4: caveman ──
if [ "$INSTALL_CAVEMAN" = 1 ]; then
  echo "══ Step 4/5: caveman — output compression skill ══"
  if [ "$HAS_NPM" = 1 ]; then
    echo "  Installing caveman globally..."
    npm install -g caveman 2>/dev/null && echo "  ✓ caveman installed" || echo "  ⚠ npm install failed — try: npm install -g caveman"
    echo ""
    echo "  To activate caveman mode, add to your CLAUDE.md:"
    echo '    You communicate in compressed telegraphic style (caveman mode).'
    echo '    Strip filler words, polite preamble, articles, and unnecessary grammar.'
    echo '    Preserve every byte of technical accuracy. Be terse but complete.'
  else
    echo "  ⚠ npm not found. Install caveman manually: npm install -g caveman"
  fi
else
  echo "══ Step 4/5: caveman — skipped ══"
fi
echo ""

# ── Step 5: Headroom (optional) ──
if [ "$INSTALL_HEADROOM" = 1 ]; then
  echo "══ Step 5/5: Headroom — API proxy / CCR ══"
  if [ "$HAS_NPM" = 1 ]; then
    echo "  Installing Headroom globally..."
    npm install -g headroom 2>/dev/null && echo "  ✓ headroom installed" || echo "  ⚠ npm install failed — try: npm install -g headroom"
    echo ""
    echo "  To use Headroom as your gateway:"
    echo "    headroom --provider anthropic --api-key \$ANTHROPIC_API_KEY --port 8080"
    echo "  Then change your agent's base_url to: http://localhost:8080"
    echo ""
    echo "  Headroom provides:"
    echo "    · CacheAligner — stabilizes prompt prefix for cache hits (INPUT)"
    echo "    · SmartCrusher — compresses tool output (FUTURE INPUT)"
    echo "    · CCR — compress-cache-retrieve: lossless output compression (FUTURE INPUT)"
  else
    echo "  ⚠ npm not found. Install Headroom manually: npm install -g headroom"
  fi
else
  echo "══ Step 5/5: Headroom — skipped (use --with-headroom to install) ══"
fi
echo ""

# ── Step 6: tokenlean-rag (chatbot, optional) ──
if [ "$INSTALL_RAG" = 1 ]; then
  echo "══ Step 6/6: tokenlean-rag — cache-optimized RAG MCP for chatbots ══"
  RAG_DIR="$SRC/03-rag-server"
  if [ -d "$RAG_DIR" ]; then
    echo "  ✓ RAG server found at: $RAG_DIR"

    # ── Build verification ──
    # 03-rag-server has zero npm dependencies (pure Node ESM), so "build" =
    # verify Node ≥ 18 (for native fetch / AbortController used by http.mjs)
    # and run the test suite.
    echo "  ── Build: checking Node version ──"
    NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "$NODE_MAJOR" -lt 18 ]; then
      echo "  ✗ Node >= 18 required (found $(node -v 2>/dev/null || echo 'unknown'))"
      echo "    Upgrade: https://nodejs.org/  or  brew install node@20"
    else
      echo "  ✓ Node $(node -v) (>= 18)"
      echo "  ── Build: running test suite ──"
      if (cd "$RAG_DIR" && node test/test-rag.mjs 2>/dev/null); then
        echo "  ✓ RAG server tests passed"
      else
        echo "  ⚠ RAG server tests had issues (run 'node $RAG_DIR/test/test-rag.mjs' for details)"
      fi
    fi

    # ── Auto-start (if --start) ──
    if [ "$START_RAG" = 1 ] && [ "$NODE_MAJOR" -ge 18 ]; then
      echo ""
      echo "  ── Auto-start: launching tokenlean-rag on port $RAG_PORT ──"

      # Generate a token if none set in env
      if [ -z "${TOKENLEAN_RAG_TOKEN:-}" ]; then
        TOKENLEAN_RAG_TOKEN="$(openssl rand -hex 16)"
        export TOKENLEAN_RAG_TOKEN
        echo "  ✓ Generated TOKENLEAN_RAG_TOKEN (32 hex chars)"
      else
        echo "  ✓ Using existing TOKENLEAN_RAG_TOKEN from env"
      fi

      # Kill any stale RAG process on the same port
      if command -v lsof >/dev/null 2>&1; then
        STALE_PID=$(lsof -ti tcp:"$RAG_PORT" 2>/dev/null || true)
        if [ -n "$STALE_PID" ]; then
          echo "  ! Port $RAG_PORT in use by PID $STALE_PID, killing..."
          kill "$STALE_PID" 2>/dev/null || true
          sleep 1
        fi
      fi

      # Start in background, log to file
      RAG_LOG="$DEST/tokenlean-rag.log"
      RAG_PID_FILE="$DEST/tokenlean-rag.pid"
      nohup node "$RAG_DIR/bin/http.mjs" --port "$RAG_PORT" --token "$TOKENLEAN_RAG_TOKEN" \
        >"$RAG_LOG" 2>&1 &
      RAG_PID=$!
      echo "$RAG_PID" > "$RAG_PID_FILE"
      echo "  ✓ RAG server started (PID $RAG_PID), logging to $RAG_LOG"

      # Wait for healthz to respond
      sleep 1
      HEALTH_OK=0
      for i in 1 2 3 4 5; do
        if curl -sf "http://127.0.0.1:$RAG_PORT/healthz" >/dev/null 2>&1; then
          HEALTH_OK=1
          break
        fi
        sleep 1
      done
      if [ "$HEALTH_OK" = 1 ]; then
        echo "  ✓ Health check passed (http://127.0.0.1:$RAG_PORT/healthz)"
      else
        echo "  ⚠ Health check failed after 5s — check $RAG_LOG"
      fi

      # ── Generate platform service unit for auto-restart ──
      echo "  ── Generating service unit for auto-restart ──"
      NODE_BIN=$(command -v node)
      if [ "$(uname)" = "Darwin" ]; then
        # macOS: launchd plist
        PLIST_PATH="$HOME/Library/LaunchAgents/com.tokenlean.rag.plist"
        cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tokenlean.rag</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$RAG_DIR/bin/http.mjs</string>
    <string>--port</string><string>$RAG_PORT</string>
    <string>--token</string><string>$TOKENLEAN_RAG_TOKEN</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TOKENLEAN_RAG_TOKEN</key><string>$TOKENLEAN_RAG_TOKEN</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$RAG_LOG</string>
  <key>StandardErrorPath</key><string>$RAG_LOG</string>
</dict>
</plist>
PLIST
        echo "  ✓ launchd plist written: $PLIST_PATH"
        echo "    Enable:  launchctl load   $PLIST_PATH"
        echo "    Disable: launchctl unload $PLIST_PATH"
      else
        # Linux: systemd user unit
        UNIT_DIR="$HOME/.config/systemd/user"
        mkdir -p "$UNIT_DIR"
        UNIT_PATH="$UNIT_DIR/tokenlean-rag.service"
        cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=TokenLean RAG MCP Server (cache-aware RAG for chatbots)
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $RAG_DIR/bin/http.mjs --port $RAG_PORT --token $TOKENLEAN_RAG_TOKEN
Environment=TOKENLEAN_RAG_TOKEN=$TOKENLEAN_RAG_TOKEN
Restart=on-failure
RestartSec=3
StandardOutput=append:$RAG_LOG
StandardError=append:$RAG_LOG

[Install]
WantedBy=default.target
UNIT
        echo "  ✓ systemd unit written: $UNIT_PATH"
        echo "    Enable:  systemctl --user daemon-reload && systemctl --user enable --now tokenlean-rag"
        echo "    Disable: systemctl --user disable --now tokenlean-rag"
      fi

      echo ""
      echo "  ── Chatbot MCP config (paste into your chatbot's MCP settings) ──"
      echo "  {"
      echo "    \"mcpServers\": {"
      echo "      \"tokenlean-rag\": {"
      echo "        \"url\": \"http://127.0.0.1:$RAG_PORT/mcp\","
      echo "        \"headers\": { \"Authorization\": \"Bearer $TOKENLEAN_RAG_TOKEN\" }"
      echo "      }"
      echo "    }"
      echo "  }"
      echo ""
      echo "  Token saved in env: export TOKENLEAN_RAG_TOKEN=$TOKENLEAN_RAG_TOKEN"
      echo "  To stop:  kill \$(cat $RAG_PID_FILE)"
    else
      # No --start: just print instructions
      echo ""
      echo "  To start the RAG MCP server for your chatbot:"
      echo "    export TOKENLEAN_RAG_TOKEN=\$(openssl rand -hex 16)"
      echo "    node $RAG_DIR/bin/http.mjs --port $RAG_PORT"
      echo ""
      echo "  Or re-run the installer with --start to auto-launch + generate service unit:"
      echo "    bash install-stack.sh --rag --start --port $RAG_PORT"
      echo ""
      echo "  Then configure your chatbot's MCP client with:"
      echo "    {\"mcpServers\":{\"tokenlean-rag\":{\"url\":\"http://127.0.0.1:$RAG_PORT/mcp\","
      echo "      \"headers\":{\"Authorization\":\"Bearer \$TOKENLEAN_RAG_TOKEN\"}}}}"
      echo ""
      echo "  For a simulation demo:"
      echo "    node $RAG_DIR/test/simulate-chatbot.mjs"
    fi
  else
    echo "  ⚠ RAG server directory not found at $RAG_DIR"
  fi
else
  echo "══ Step 6/6: tokenlean-rag — skipped (use --rag to install) ══"
fi
echo ""

# ── Summary ──
echo "╔════════════════════════════════════════════════════════╗"
echo "║  Installation Summary                                 ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "  L1 (INPUT/FUTURE): Headroom     $([ "$INSTALL_HEADROOM" = 1 ] && echo '→ try: headroom --provider anthropic ...' || echo '→ optional: install with --with-headroom')"
echo "  L1 (INPUT/chatbot): tokenlean-rag $([ "$INSTALL_RAG" = 1 ] && echo '→ ready on port 8766' || echo '→ install with --rag')"
echo "  L2 (OUTPUT/FUTURE): tokenlean-mcp  → configured for Claude Code above"
echo "  L3 (FUTURE): rtk     $([ "$INSTALL_RTK" = 1 ] && echo '→ run: rtk -- claude' || echo '→ skipped')"
echo "  L3 (FUTURE): tokenlean-workflow   → hooks installed (bash-guard, write-guard, etc.)"
echo "  L4 (OUTPUT): caveman $([ "$INSTALL_CAVEMAN" = 1 ] && echo '→ add caveman line to CLAUDE.md' || echo '→ skipped')"
echo ""
echo "  Dimension coverage:"
echo "    INPUT  (prefix cache):  workflow(cache-doctor) + Headroom(CacheAligner)"
echo "    OUTPUT (edit+narration): workflow(write-guard) + MCP(hash edits) + caveman"
echo "    FUTURE (tool output):   workflow(bash-guard) + MCP(bounded tools) + rtk"
echo ""
echo "  See STACK-README.md for configuration details."
echo ""

# ── Verify tests ──
echo "── Verifying tokenlean tests ──"
if [ -f "$MCP_DIR/test/test-stdio.mjs" ]; then
  (cd "$MCP_DIR" && node test/test-stdio.mjs 2>/dev/null) && echo "  ✓ MCP stdio tests passed" || echo "  ⚠ MCP stdio tests had failures (see above)"
fi
if [ -f "$SRC/01-workflow/test/test-hooks.mjs" ]; then
  node "$SRC/01-workflow/test/test-hooks.mjs" 2>/dev/null && echo "  ✓ workflow tests passed" || echo "  ⚠ workflow tests had failures (see above)"
fi
if [ "$INSTALL_RAG" = 1 ] && [ -d "$SRC/03-rag-server" ]; then
  node "$SRC/03-rag-server/test/simulate-chatbot.mjs" 2>/dev/null && echo "  ✓ RAG simulation passed" || echo "  ⚠ RAG simulation had issues (see above)"
fi

echo ""
echo "Done."
echo "  For coding agents: run your agent with 'rtk -- claude code' (or rtk -- opencode)"
echo "  For chatbots:      bash install-stack.sh --rag --start  (auto-build + launch + service unit)"
echo "  The full stack: CLI compression + behavioral hooks + hash-anchored editing + API proxy."
