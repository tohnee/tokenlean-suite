#!/usr/bin/env bash
# install.sh — install tokenlean-workflow into a project, out of the box.
# Detects target agent, copies files into the right layout, wires settings,
# and runs the self-test. Zero dependencies (Node >= 18 for hooks).
#
#   bash install.sh [--target claude|opencode|auto] [--global] [DEST]
#
# Default: --target auto, DEST = current directory.

set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET="auto"; GLOBAL=0; DEST="$(pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2;;
    --global) GLOBAL=1; shift;;
    -h|--help) sed -n '2,11p' "$0"; exit 0;;
    *) DEST="$1"; shift;;
  esac
done

echo "tokenlean-workflow installer"
echo "────────────────────────────"

# Node check (hooks need it)
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Hooks need Node >= 18." >&2; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "✗ Node $NODE_MAJOR; need >= 18." >&2; exit 1; }
echo "✓ Node $(node -v)"

# auto-detect target
if [ "$TARGET" = "auto" ]; then
  if [ -f "$DEST/opencode.json" ] || [ -d "$DEST/.opencode" ]; then TARGET="opencode"
  elif [ -f "$DEST/CLAUDE.md" ] || [ -d "$DEST/.claude" ]; then TARGET="claude"
  else TARGET="claude"; fi
fi
echo "✓ target: $TARGET   dest: $DEST"

install_claude() {
  local base
  if [ "$GLOBAL" = "1" ]; then base="$HOME/.claude"; else base="$DEST/.claude"; fi
  mkdir -p "$base/skills" "$base/commands" "$base/hooks" "$base/lib"
  cp -r "$SRC/claude-code/skills/." "$base/skills/"
  cp -r "$SRC/claude-code/commands/." "$base/commands/"
  cp -r "$SRC/claude-code/hooks/." "$base/hooks/"
  cp -r "$SRC/claude-code/lib/." "$base/lib/"
  echo "✓ installed skills, commands, hooks, lib → $base"
  echo
  echo "  ⮕ FINAL STEP: merge $base/../settings.snippet.json into $base/settings.json"
  echo "    (or copy the snippet shipped at: $SRC/claude-code/settings.snippet.json)"
  cp "$SRC/claude-code/settings.snippet.json" "$base/settings.snippet.json"
  echo "    A copy was placed at $base/settings.snippet.json for convenience."
  echo
  echo "  Optional, recommended (makes OUTPUT discipline enforced):"
  echo '    add to settings.json permissions.deny: ["Write(src/**)"] to push edits through Edit.'
}

install_opencode() {
  local base
  if [ "$GLOBAL" = "1" ]; then base="$HOME/.config/opencode"; else base="$DEST/.opencode"; fi
  mkdir -p "$base/plugin" "$base/command"
  cp "$SRC/opencode/plugin/tokenlean.ts" "$base/plugin/"
  cp -r "$SRC/opencode/command/." "$base/command/"
  cp "$SRC/opencode/tokenlean-instructions.md" "$base/"
  echo "✓ installed plugin, command, instructions → $base"
  echo
  echo "  ⮕ FINAL STEP: merge $SRC/opencode/opencode.snippet.json into your opencode.json"
  echo "    (the plugin auto-loads from $base/plugin/; instructions wire via the snippet)"
}

echo
case "$TARGET" in
  claude)   install_claude;;
  opencode) install_opencode;;
  *) echo "✗ unknown target: $TARGET" >&2; exit 1;;
esac

echo
echo "Running self-test..."
if node "$SRC/test/test-hooks.mjs" >/tmp/tl-wf.log 2>&1; then
  echo "✓ hooks: $(tail -1 /tmp/tl-wf.log | tr -d '═ ')"
  if node "$SRC/test/test-skills.mjs" >>/tmp/tl-wf.log 2>&1; then
    echo "✓ skills: $(node -p "let c='$(tail -1 /tmp/tl-wf.log | tr -d '═ ')';c.match(/\d+ passed/)?.[0]||'ok'")"
  else
    echo "✗ skills test failed; see /tmp/tl-wf.log" >&2; exit 1
  fi
else
  echo "✗ hooks test failed; see /tmp/tl-wf.log" >&2; exit 1
fi

cat <<EOF

Done. Three token dimensions are now wired:
  INPUT        prefix-stable skill + session-start hook + /cache-report
  OUTPUT       surgical-edits skill + write-guard hook
  FUTURE INPUT lean-context skill + bash-guard hook + precompact hook + /lean-compact

Tuning (env vars): TOKENLEAN_BASH_MODE=guard|auto|off
                   TOKENLEAN_WRITE_MODE=guard|warn|off
Run /token-audit anytime for a snapshot. See DESIGN.md for the full model.

╔══════════════════════════════════════════════════════════════════════╗
║ RECOMMENDED: install additional tools for each token-saving layer   ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                    ║
║  rtk  (cli output compression)                                     ║
║    git clone https://github.com/azat-io/rtk                        ║
║    cargo install --path .                                          ║
║    # wraps agent command: rtk -- claude code                       ║
║    # replaces bash-guard's suggestion-only approach with real      ║
║    # output compression (60-90% CLI output reduction)              ║
║                                                                    ║
║  Headroom (api proxy, prefix cache + CCR)                          ║
║    npm install -g headroom                                         ║
║    headroom --provider anthropic --api-key \$KEY --port 8080         ║
║    # change agent's base_url to http://localhost:8080              ║
║    # provides: CacheAligner (INPUT), SmartCrusher (FUTURE), CCR    ║
║                                                                    ║
║  caveman (output narrative compression)                            ║
║    npm install -g caveman                                          ║
║    # add to CLAUDE.md: "You communicate in compressed telegraphic   ║
║    #  style (caveman mode)"                                       ║
║    # cuts narrated output tokens by ~65%, complementary to         ║
║    # tokenlean's edit-focused OUTPUT optimization                  ║
║                                                                    ║
║  See STACK-README.md in this directory for the full stack setup.   ║
║                                                                    ║
╚══════════════════════════════════════════════════════════════════════╝

EOF
