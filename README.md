# Claude Idle Compactor

A Claude Code plugin that compacts a session after **50 minutes without activity**, while its **1-hour prompt cache** is still warm. It works in the terminal and in the Claude desktop app's **Code tab**. Install it once; later changes pushed to this repository reach every installation on the next session start.

## Why

On a Pro or Max plan, Claude Code caches each conversation's prompt for an hour. After an hour of inactivity the cache expires, and your next message re-sends the entire conversation as uncached input: for a 150k-token session, that's 150k tokens at the full cache-write rate.

Compacting shortly before the cache expires costs little: the summarization request reads the conversation from cache at about a tenth of the input price, and the history becomes a short summary. If you return hours later, only that summary is sent uncached.

Tradeoffs:

- The summary itself is billed as output tokens, and it is paid for every idle session, including ones you never reopen. The savings come from large sessions that you do come back to. Sessions under 30,000 tokens of context are left alone by default.
- Compaction keeps a summary, not every detail. This is the same `/compact` you'd run yourself.
- Anthropic does not publish exactly how cached tokens count against plan limits; the reasoning above uses API price ratios.

## Install

Paste this into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/intenex/claude-idle-compactor/main/install.sh | bash
```

Or download the repository ([ZIP](https://github.com/intenex/claude-idle-compactor/archive/refs/heads/main.zip)), unzip it, and double-click **Install.command**. The first time, macOS may ask you to confirm (right-click → Open).

The installer:

1. adds this repository as a Claude Code plugin marketplace and installs `idle-compactor` for your user,
2. turns on **auto-update** for that marketplace in `~/.claude/settings.json`,
3. sets `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the same file's `env`. The plugin API it relies on is early access and off by default.

It backs up `settings.json` first, and it's safe to run again. It needs macOS, git, and either the Claude desktop app or the `claude` CLI. If the CLI isn't on your `PATH`, it uses the copy of Claude Code bundled with the desktop app.

**New sessions** load the plugin. Sessions that are already open pick it up when you restart them.

## How it works

The plugin is a Claude Code *hooks module* (the function-hooks plugin API). Inside every session:

- `turn.complete` records when the last response arrived and arms the session.
- A 30-second `$.clock.every` poll checks the wall clock. Once the session has been idle for `idle_minutes`, it calls `$.session.compact()`, the same call `/compact` makes, run between turns.
- The window closes at `cutoff_minutes`. If the Mac slept through the window, the check fires late and is skipped: by then the cache is probably gone, and compacting would be billed at full price.
- Each idle period is handled once. Only a new response re-arms the session.

It does nothing while a turn is running, including while a turn waits on a permission prompt or a question. It also skips:

- sessions with less than `min_context_tokens` of context,
- accounts past their plan limit, since usage credits get a 5-minute cache,
- setups that force a 5-minute cache (`CLAUDE_CODE_PROMPT_CACHE_TTL=5m`, `FORCE_PROMPT_CACHING_5M=1`, `promptCacheTtl: "5m"`),
- anything beyond `max_per_day` compactions per UTC day across all sessions.

Unlike typing keystrokes into a terminal, it never touches the prompt box, so a half-typed message stays as it was.

## Settings

Every setting appears in `/config` (under the plugin) and can also be set in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "idle-compactor@claude-idle-compactor": {
      "options": { "idle_minutes": 50, "cutoff_minutes": 56, "min_context_tokens": 30000, "max_per_day": 50, "enabled": true }
    }
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Pause without uninstalling |
| `idle_minutes` | `50` | Minutes idle before compacting (under 60) |
| `cutoff_minutes` | `56` | Skip if the check first runs later than this |
| `min_context_tokens` | `30000` | Leave smaller sessions alone |
| `max_per_day` | `50` | Cap across all sessions per UTC day |

In any session, `/idle-compactor` shows the settings, this session's idle state, today's count, and the last few results (tokens before → after).

## Updates

The installer sets `"autoUpdate": true` on the marketplace, so Claude Code checks this repository after each session starts and installs the new version. New sessions then run it, and open sessions run it after `/reload-plugins`. The plugin has no `version` field, so every commit pushed to `main` is a release.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/intenex/claude-idle-compactor/main/uninstall.sh | bash
```

Or double-click **Uninstall.command**. It removes the plugin, the marketplace, and the settings the installer added.

## Limits

- **Desktop app, Chat tab:** not covered. Those conversations run on claude.ai, not Claude Code, and have no `/compact`.
- **Early-access API:** the function-hooks API may change between Claude Code releases. If a release breaks the module, Claude Code skips it and nothing is compacted. A fix pushed here reaches everyone through auto-update. Validated with Claude Code 2.1.270 and 2.1.280.
- **Timing:** the idle clock starts when a turn completes, which is slightly after the turn's last request was sent. The 50/56-minute defaults leave room for that.
- **Installer:** macOS only. Elsewhere, run `claude plugin marketplace add intenex/claude-idle-compactor` and `claude plugin install idle-compactor@claude-idle-compactor`, then add `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` to `env` and `"autoUpdate": true` to the marketplace's `extraKnownMarketplaces` entry in `settings.json`.

## Development

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate plugin
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugin
```

The tests run the module against Claude Code's own engine, with the clock, store, and environment mocked. To try local changes in a session, run `claude --plugin-dir ./plugin`.
