// Idle compactor: compacts a Claude Code session that has sat idle for
// `idle_minutes` (default 50), while its 1-hour prompt cache is still warm.
//
// Compacting while warm reads the conversation from cache (about a tenth of
// the input price) and leaves a short summary in its place. Coming back after
// the cache has expired then re-sends that summary instead of the whole
// history uncached.
//
// Built on Claude Code's function-hooks plugin API (early access): the
// `turn.complete` event marks the last response, `$.clock.every` polls the
// wall clock, and `$.session.compact()` is the same call `/compact` makes.
//
// The engine reads which `$` calls a module makes from its source, so every
// function that takes `$` is declared at the top of this file.

import type { EngineInterface, Register, Timer } from 'claude-code'

const MINUTE_MS = 60_000
const POLL_MS = 30_000
const LOG_KEY = 'log'
const LOG_LIMIT = 200
const STATUS_COMMAND = 'idle-compactor'

type Config = {
  enabled: boolean
  idleMs: number
  cutoffMs: number
  minContextTokens: number
  maxPerDay: number
}

type State = {
  config: Config
  // Wall-clock time of the last main-loop response: the proxy for when the
  // prompt cache was last refreshed. Undefined until a turn completes here.
  lastResponseAt: number | undefined
  turnRunning: boolean
  // One idle compaction per idle period: set by a completed turn, cleared once
  // that idle period has been handled (compacted, skipped or missed).
  armed: boolean
  compacting: boolean
  poll: Timer | undefined
  commandRegistered: boolean
}

type LogEntry = {
  at: string
  session: string
  outcome: 'compacted' | 'skipped' | 'failed'
  reason?: string
  idleMinutes: number
  contextTokens?: number
  tokensBefore?: number
  tokensAfter?: number
  compactUsage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }
}

function numberOption(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function readConfig(options: Record<string, unknown>): Config {
  const idleMinutes = numberOption(options.idle_minutes, 50, 0.5, 58)
  const cutoffMinutes = Math.max(numberOption(options.cutoff_minutes, 56, 1, 59), idleMinutes + 0.5)
  return {
    enabled: options.enabled !== false,
    idleMs: idleMinutes * MINUTE_MS,
    cutoffMs: Math.min(cutoffMinutes, 59) * MINUTE_MS,
    minContextTokens: numberOption(options.min_context_tokens, 30_000, 0, 2_000_000),
    maxPerDay: Math.floor(numberOption(options.max_per_day, 50, 0, 1000)),
  }
}

function minutes(ms: number): number {
  return Math.round((ms / MINUTE_MS) * 10) / 10
}

function formatTokens(n: number | undefined): string {
  return n === undefined ? '?' : n.toLocaleString('en-US')
}

function stopPolling(state: State): void {
  state.poll?.cancel()
  state.poll = undefined
}

function startPolling($: EngineInterface, state: State): void {
  if (state.poll !== undefined) return
  state.poll = $.clock.every(POLL_MS, () => {
    void safeCheck($, state)
  })
}

// A timer callback has no dispatch to report a failure to: keep one failed
// check (an engine call refused mid-shutdown, say) from becoming an unhandled
// rejection.
async function safeCheck($: EngineInterface, state: State): Promise<void> {
  try {
    await check($, state)
  } catch (err) {
    state.compacting = false
    $.ui.log(`idle-compactor: check failed (${String(err).slice(0, 200)})`, { to: 'debug' })
  }
}

async function record($: EngineInterface, entry: Omit<LogEntry, 'at' | 'session'>): Promise<void> {
  try {
    const at = new Date(await $.clock.now()).toISOString()
    const session = await $.session.id()
    const previous = await $.store.get(LOG_KEY)
    const log = Array.isArray(previous) ? (previous as LogEntry[]) : []
    log.push({ at, session, ...entry })
    await $.store.set(LOG_KEY, log.slice(-LOG_LIMIT))
  } catch (err) {
    $.ui.log(`idle-compactor: could not write its log (${String(err)})`, { to: 'debug' })
  }
}

// A five-minute cache TTL (usage credits past the plan limit, or an explicit
// setting) means the cache is long gone at 50 minutes: compacting then would
// re-read the whole conversation at full price, so skip.
async function shortCacheReason($: EngineInterface): Promise<string | undefined> {
  if ((await $.env.get('FORCE_PROMPT_CACHING_5M')) === '1') return 'FORCE_PROMPT_CACHING_5M is set'
  if ((await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')) === '5m') return 'CLAUDE_CODE_PROMPT_CACHE_TTL is 5m'
  const settings = (await $.settings.read()) as Record<string, unknown>
  if (settings.promptCacheTtl === '5m') return 'promptCacheTtl is 5m'
  const { rateLimits } = await $.session.usage()
  const exhausted = rateLimits.find(limit => limit.percentUsed >= 100)
  if (exhausted !== undefined) return `the ${exhausted.kind} limit is used up (usage credits get a 5-minute cache)`
  return undefined
}

async function check($: EngineInterface, state: State): Promise<void> {
  const { config } = state
  if (!state.armed || state.compacting || state.turnRunning || state.lastResponseAt === undefined) return
  const idleMs = (await $.clock.now()) - state.lastResponseAt
  if (idleMs < config.idleMs) return

  // From here this idle period is handled exactly once.
  state.armed = false
  stopPolling(state)
  const idleMinutes = minutes(idleMs)

  if (idleMs >= config.cutoffMs) {
    await record($, { outcome: 'skipped', reason: 'missed-window', idleMinutes })
    return
  }

  const usage = await $.session.usage()
  const contextTokens = usage.context.tokens
  if (contextTokens === undefined || contextTokens < config.minContextTokens) {
    await record($, { outcome: 'skipped', reason: 'small-context', idleMinutes, contextTokens })
    return
  }

  const shortCache = await shortCacheReason($)
  if (shortCache !== undefined) {
    await record($, { outcome: 'skipped', reason: `short-cache: ${shortCache}`, idleMinutes, contextTokens })
    return
  }

  const dayKey = `attempts:${new Date(await $.clock.now()).toISOString().slice(0, 10)}`
  const attemptsToday = Number((await $.store.get(dayKey)) ?? 0)
  if (attemptsToday >= config.maxPerDay) {
    await record($, { outcome: 'skipped', reason: 'daily-cap', idleMinutes, contextTokens })
    return
  }

  // The checks above took time: confirm the window still holds right before
  // dispatching, and that no turn started meanwhile.
  const dispatchIdleMs = (await $.clock.now()) - state.lastResponseAt
  if (state.turnRunning || dispatchIdleMs >= config.cutoffMs) {
    await record($, {
      outcome: 'skipped',
      reason: state.turnRunning ? 'turn-started' : 'missed-window',
      idleMinutes: minutes(dispatchIdleMs),
      contextTokens,
    })
    return
  }

  await $.store.set(dayKey, attemptsToday + 1)
  state.compacting = true
  try {
    const result = await $.session.compact()
    if (result.skip !== undefined) {
      await record($, { outcome: 'skipped', reason: `vetoed: ${result.skip}`, idleMinutes, contextTokens })
      return
    }
    await record($, {
      outcome: 'compacted',
      idleMinutes,
      contextTokens,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      compactUsage: result.usage,
    })
    $.ui.log(
      `idle-compactor: compacted after ${Math.round(idleMinutes)} min idle, while the prompt cache was warm ` +
        `(${formatTokens(result.tokensBefore ?? contextTokens)} → ${formatTokens(result.tokensAfter)} tokens)`,
    )
  } catch (err) {
    // Rejects when a turn started in the meantime; the next idle period gets
    // its own chance.
    await record($, { outcome: 'failed', reason: String(err).slice(0, 300), idleMinutes, contextTokens })
  } finally {
    state.compacting = false
  }
}

async function statusText($: EngineInterface, state: State): Promise<string> {
  const { config } = state
  const now = await $.clock.now()
  const lines: string[] = []
  lines.push(
    `idle-compactor ${config.enabled ? 'on' : 'off'}: compacts after ${minutes(config.idleMs)} min idle, ` +
      `gives up after ${minutes(config.cutoffMs)} min, needs ${formatTokens(config.minContextTokens)}+ tokens of context, ` +
      `at most ${config.maxPerDay}/day`,
  )
  if (state.lastResponseAt === undefined) {
    lines.push('This session: no response yet since the plugin loaded.')
  } else {
    const idle = minutes(now - state.lastResponseAt)
    const detail = state.turnRunning
      ? 'a turn is running'
      : state.armed
        ? `idle ${idle} min; compacts at ${minutes(config.idleMs)} min`
        : `idle ${idle} min; this idle period is already handled`
    lines.push(`This session: ${detail}.`)
  }
  const dayKey = `attempts:${new Date(now).toISOString().slice(0, 10)}`
  lines.push(`Attempts today (UTC, all sessions): ${Number((await $.store.get(dayKey)) ?? 0)}`)
  const log = await $.store.get(LOG_KEY)
  const recent = Array.isArray(log) ? (log as LogEntry[]).slice(-5).reverse() : []
  if (recent.length > 0) {
    lines.push('Recent:')
    for (const entry of recent) {
      const detail =
        entry.outcome === 'compacted'
          ? `${formatTokens(entry.tokensBefore ?? entry.contextTokens)} → ${formatTokens(entry.tokensAfter)} tokens`
          : (entry.reason ?? '')
      lines.push(`  ${entry.at}  ${entry.outcome}  ${entry.idleMinutes} min idle  ${detail}`)
    }
  }
  return lines.join('\n')
}

async function ensureCommand($: EngineInterface, state: State): Promise<void> {
  if (state.commandRegistered) return
  state.commandRegistered = true
  try {
    await $.command.register({ name: STATUS_COMMAND, description: 'Show idle auto-compaction status and recent results' })
  } catch {
    state.commandRegistered = false
  }
}

export const register: Register = (on, options) => {
  const state: State = {
    config: readConfig(options),
    lastResponseAt: undefined,
    turnRunning: false,
    armed: false,
    compacting: false,
    poll: undefined,
    commandRegistered: false,
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await ensureCommand($, state)
    return result
  })

  on('command.run', { command: STATUS_COMMAND }, async $ => ({ text: await statusText($, state) }))

  on('turn.start', async ($, e, next) => {
    state.turnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Subagents' turns run on their own caches; only the main loop counts.
    if (e.agentId !== undefined) return result
    state.turnRunning = false
    // A plugin reload (auto-update, /reload-plugins) runs register() again
    // without a new session.start, so the command is ensured here too.
    await ensureCommand($, state)
    // A turn that got no response did not touch the cache.
    if (e.usage === undefined || !state.config.enabled) return result
    state.lastResponseAt = await $.clock.now()
    state.armed = true
    startPolling($, state)
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // Another compaction of the main conversation (/compact, auto-compact)
    // already replaced the history: nothing is left to do this idle period.
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      state.armed = false
      stopPolling(state)
    }
    return result
  })

  // No `session.end` hook: older builds (2.1.270) do not have the event, and a
  // module that hooks an unknown event is not loaded at all. After a /clear the
  // new conversation has no context reading until its first response, so
  // `check` skips it as too small.
}
