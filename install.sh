#!/bin/bash
# Installs the idle-compactor Claude Code plugin with automatic updates.
#
#   curl -fsSL https://raw.githubusercontent.com/intenex/claude-idle-compactor/main/install.sh | bash
#
# 1. Adds this repository as a Claude Code plugin marketplace and installs the
#    plugin for your user, so every terminal and desktop Code-tab session
#    loads it.
# 2. Turns on auto-update for the marketplace in ~/.claude/settings.json, so
#    each new push to the repository reaches you on your next session start.
# 3. Sets CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in the same file's "env": the
#    plugin API the compactor uses is early access and off by default.
#
# Safe to run again: it repairs or refreshes an existing install.

set -euo pipefail

REPO="intenex/claude-idle-compactor"
MARKETPLACE="claude-idle-compactor"
PLUGIN="idle-compactor@${MARKETPLACE}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="${CONFIG_DIR}/settings.json"

say() { printf '%s\n' "$*"; }
fail() { printf 'idle-compactor install failed: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS; see the README for the manual steps"

# The claude CLI if it is installed, else the copy the Claude desktop app
# bundles (newest version first).
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

CLAUDE="$(find_claude)" || fail "Claude Code was not found. Install the Claude desktop app or Claude Code first."
say "Using Claude Code at: $CLAUDE ($("$CLAUDE" --version 2>/dev/null || echo 'unknown version'))"

command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1 \
  || fail "git is required to fetch the plugin. Run: xcode-select --install"

# 1. Marketplace and plugin.
if "$CLAUDE" plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE"; then
  say "Refreshing the $MARKETPLACE marketplace..."
  "$CLAUDE" plugin marketplace update "$MARKETPLACE"
else
  say "Adding the $MARKETPLACE marketplace..."
  "$CLAUDE" plugin marketplace add "$REPO"
fi

say "Installing $PLUGIN..."
if ! "$CLAUDE" plugin install "$PLUGIN" --scope user; then
  "$CLAUDE" plugin update "$PLUGIN" --scope user || fail "could not install $PLUGIN"
fi
"$CLAUDE" plugin enable "$PLUGIN" --scope user >/dev/null 2>&1 || true

# 2 and 3. Settings: auto-update for the marketplace, and the function-hooks
# switch. JavaScript for Automation ships with macOS, so no Python or jq is
# needed; the previous file is kept as a backup.
mkdir -p "$CONFIG_DIR"
if [ -f "$SETTINGS" ]; then
  BACKUP="${SETTINGS}.bak-idle-compactor-$(date +%Y%m%d-%H%M%S)"
  cp -p "$SETTINGS" "$BACKUP"
  say "Backed up settings to $BACKUP"
fi

SETTINGS_PATH="$SETTINGS" REPO="$REPO" MARKETPLACE="$MARKETPLACE" PLUGIN="$PLUGIN" \
  /usr/bin/osascript -l JavaScript >/dev/null <<'JXA'
ObjC.import('Foundation')
const env = $.NSProcessInfo.processInfo.environment
const read = name => ObjC.unwrap(env.objectForKey(name))
const path = read('SETTINGS_PATH')
const fm = $.NSFileManager.defaultManager
let settings = {}
if (fm.fileExistsAtPath(path)) {
  const text = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null))
  if (text && text.trim() !== '') {
    try {
      settings = JSON.parse(text)
    } catch (err) {
      throw new Error('settings.json is not valid JSON; fix it and run the installer again (' + err + ')')
    }
  }
}
settings.env = Object.assign({}, settings.env, { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' })
const known = Object.assign({}, settings.extraKnownMarketplaces)
known[read('MARKETPLACE')] = Object.assign({}, known[read('MARKETPLACE')], {
  source: { source: 'github', repo: read('REPO') },
  autoUpdate: true,
})
settings.extraKnownMarketplaces = known
settings.enabledPlugins = Object.assign({}, settings.enabledPlugins, { [read('PLUGIN')]: true })
const out = $.NSString.alloc.initWithUTF8String(JSON.stringify(settings, null, 2) + '\n')
if (!out.writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)) {
  throw new Error('could not write ' + path)
}
JXA

say "Updated $SETTINGS (auto-update on, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1)"

"$CLAUDE" plugin list 2>/dev/null | grep -q "idle-compactor" || fail "the plugin does not appear in 'claude plugin list'"

say ""
say "idle-compactor is installed."
say "New Claude Code sessions (terminal and the desktop app's Code tab) load it;"
say "sessions that are already open pick it up when restarted."
say "In a session, /idle-compactor shows its status. Updates install automatically."
