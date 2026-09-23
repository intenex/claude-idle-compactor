#!/bin/bash
# Removes the idle-compactor plugin, its marketplace, and the settings the
# installer added (auto-update entry, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS).
#
#   curl -fsSL https://raw.githubusercontent.com/intenex/claude-idle-compactor/main/uninstall.sh | bash

set -euo pipefail

MARKETPLACE="claude-idle-compactor"
PLUGIN="idle-compactor@${MARKETPLACE}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="${CONFIG_DIR}/settings.json"

say() { printf '%s\n' "$*"; }

find_claude() {
  local candidate
  if candidate="$(command -v claude 2>/dev/null)" && [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  for candidate in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  local bundled="$HOME/Library/Application Support/Claude/claude-code"
  if [ -d "$bundled" ]; then
    local version
    for version in $(ls -1 "$bundled" | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
      candidate="$bundled/$version/claude.app/Contents/MacOS/claude"
      if [ -x "$candidate" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  fi
  return 1
}

if CLAUDE="$(find_claude)"; then
  "$CLAUDE" plugin uninstall "$PLUGIN" --scope user || true
  "$CLAUDE" plugin marketplace remove "$MARKETPLACE" || true
fi

if [ -f "$SETTINGS" ]; then
  cp -p "$SETTINGS" "${SETTINGS}.bak-idle-compactor-$(date +%Y%m%d-%H%M%S)"
  SETTINGS_PATH="$SETTINGS" MARKETPLACE="$MARKETPLACE" PLUGIN="$PLUGIN" \
    /usr/bin/osascript -l JavaScript >/dev/null <<'JXA'
ObjC.import('Foundation')
const env = $.NSProcessInfo.processInfo.environment
const read = name => ObjC.unwrap(env.objectForKey(name))
const path = read('SETTINGS_PATH')
const text = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null))
const settings = JSON.parse(text)
if (settings.env) delete settings.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
if (settings.extraKnownMarketplaces) delete settings.extraKnownMarketplaces[read('MARKETPLACE')]
if (settings.enabledPlugins) delete settings.enabledPlugins[read('PLUGIN')]
const out = $.NSString.alloc.initWithUTF8String(JSON.stringify(settings, null, 2) + '\n')
out.writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)
JXA
fi

say "idle-compactor is uninstalled. Sessions already open keep it until they restart."
