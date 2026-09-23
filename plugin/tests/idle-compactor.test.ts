// Runs under `claude plugin test plugin/` against Claude Code's own engine,
// with the clock, store and environment mocked beneath the plugin. The plugin
// loads with its manifest defaults: 50 min idle, 56 min cutoff, 30,000-token
// minimum context, 50 compactions a day.

import type { On, SessionRateLimit } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000
const START = Date.parse('2026-09-23T10:00:00Z')
const USAGE = {
  input_tokens: 12,
  output_tokens: 300,
  cache_read_input_tokens: 110_000,
  cache_creation_input_tokens: 2_000,
  model: 'claude-opus-5-5',
}

type World = {
  // Refuse the direct $.session.compact(), as an SDK session (the desktop
  // app's Code tab) does, so the plugin must run /compact instead.
  headless: boolean
  // The test's own engine, which the /compact stub drives.
  engine: Engine | undefined
  commandRuns: string[]
  store: Map<string, unknown>
  logs: string[]
  compactions: number
  contextTokens: number | undefined
  rateLimits: SessionRateLimit[]
  settings: Record<string, unknown>
}

function world(on: On, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: START })
  mock.env(on, env)
  const w: World = { headless: false, engine: undefined, commandRuns: [], store: new Map(), logs: [], compactions: 0, contextTokens: 120_000, rateLimits: [], settings: {} }
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  // Calls on `$` (store, usage, settings, session id) are answered beneath the
  // plugin with `{ value }`; the store lives in a Map the test can read, since
  // a test's own `$` has no store noun.
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }))
  on('store.set', ($, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.id', () => ({ value: 'test-session' }))
  on('settings.read', () => ({ value: w.settings }))
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: { tokens: w.contextTokens, window: 200_000 },
      rateLimits: w.rateLimits,
    },
  }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  // /compact, run by the plugin through $.command.run: in an SDK session it
  // runs inside a turn of its own, whose compaction passes the plugin's hooks.
  on('command.run', { command: 'compact' }, async ($, e) => {
    w.commandRuns.push(e.command)
    const engine = w.engine
    if (engine === undefined) throw new Error('set w.engine to run /compact')
    await engine.turn.start({ text: '/compact', turnId: 'compact-turn' })
    await engine.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
    await engine.turn.complete({
      answer: '',
      durationMs: 5_000,
      isAborted: false,
      turnId: 'compact-turn',
      reason: 'answer',
      usage: USAGE,
    })
    return { text: 'Compacted' }
  })
  on('session.compact', ($, e) => {
    if (w.headless && e.trigger !== 'manual') {
      throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on')
    }
    w.compactions += 1
    return {
      messages: [{ role: 'user', text: 'summary', toolUses: [] }],
      tokensBefore: w.contextTokens,
      tokensAfter: 14_000,
    }
  })
  return { clock, w }
}

function lastReason(w: World): string | undefined {
  const log = w.store.get('log') as { reason?: string }[] | undefined
  return log?.at(-1)?.reason
}

function completeTurn($: Engine, turnId = 't1', withUsage = true) {
  return $.turn.complete({
    answer: 'done',
    durationMs: 1_000,
    isAborted: false,
    turnId,
    reason: 'answer',
    ...(withUsage ? { usage: USAGE } : {}),
  })
}

describe('timing', () => {
  test('compacts once the session has been idle for 50 minutes', async ($, on) => {
    const { clock, w } = world(on)
    await completeTurn($)
    await clock.advance(49 * MINUTE)
    expect(w.compactions).toBe(0)
    await clock.advance(2 * MINUTE)
    expect(w.compactions).toBe(1)
  })

  test('compacts only once per idle period', async ($, on) => {
    const { clock, w } = world(on)
    await completeTurn($)
    await clock.advance(55 * MINUTE)
    await clock.advance(120 * MINUTE)
    expect(w.compactions).toBe(1)
  })

  test('a new turn restarts the idle clock', async ($, on) => {
    const { clock, w } = world(on)
    await completeTurn($, 't1')
    await clock.advance(40 * MINUTE)
    await $.turn.start({ text: 'more', turnId: 't2' })
    await completeTurn($, 't2')
    await clock.advance(40 * MINUTE)
    expect(w.compactions).toBe(0)
    await clock.advance(11 * MINUTE)
    expect(w.compactions).toBe(1)
  })

  test('each completed turn earns a new idle compaction', async ($, on) => {
    const { clock, w } = world(on)
    await completeTurn($, 't1')
    await clock.advance(51 * MINUTE)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await completeTurn($, 't2')
    await clock.advance(51 * MINUTE)
    expect(w.compactions).toBe(2)
  })

  test('does nothing while a turn is running', async ($, on) => {
    const { clock, w } = world(on)
    await completeTurn($, 't1')
    await clock.advance(30 * MINUTE)
    await $.turn.start({ text: 'long task', turnId: 't2' })
    await clock.advance(40 * MINUTE)
    expect(w.compactions).toBe(0)
  })

  // Loaded beside the plugin under test: once the compactor starts its poll
  // timer (after it has recorded the last response), the wall clock reads an
  // hour later while the timer still waits, as when the Mac sleeps.
  const sleeper: Plugin = {
    name: 'sleeper',
    register(on) {
      let slept = false
      on('clock.every', ($, e, next) => {
        slept = true
        return next(e)
      })
      on('clock.now', async ($, e, next) => {
        // A call on `$` answers `{ value }` down the chain.
        const answer = (await next(e)) as unknown
        const now = typeof answer === 'number' ? answer : (answer as { value: number }).value
        return { value: slept ? now + 60 * 60_000 : now } as never
      })
    },
  }

  test('skips a window it missed (the Mac slept past the cutoff)', { plugins: [sleeper] }, async ($, on) => {
    const { clock, w } = world(on)
    await completeTurn($)
    await clock.advance(1 * MINUTE)
    expect(w.compactions).toBe(0)
    const log = w.store.get('log') as { outcome: string; reason?: string }[]
    expect(log.at(-1)?.reason).toBe('missed-window')
    await clock.advance(120 * MINUTE)
    expect(w.compactions).toBe(0)
  })

  test('a turn without a response does not arm it', async ($, on) => {
    const { clock, w } = world(on)
    await completeTurn($, 't1', false)
    await clock.advance(55 * MINUTE)
    expect(w.compactions).toBe(0)
  })
})

// An SDK session (the desktop app's Code tab) starts non-interactive and
// refuses the direct $.session.compact(); its compaction runs inside a
// /compact turn. (The engine skips a test hook that throws, so the refusal
// itself is exercised against a real desktop session, not here.)
async function startHeadless($: Engine, on: On, w: World): Promise<void> {
  w.headless = true
  w.engine = $
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
}

describe('SDK sessions (desktop Code tab)', () => {
  test('runs /compact in a session that started non-interactive', async ($, on) => {
    const { clock, w } = world(on)
    await startHeadless($, on, w)
    await completeTurn($)
    await clock.advance(51 * MINUTE)
    expect(w.commandRuns).toEqual(['compact'])
    expect(w.compactions).toBe(1)
    const log = w.store.get('log') as { outcome: string; tokensAfter?: number }[]
    expect(log.map(entry => entry.outcome)).toEqual(['compacted'])
    expect(log[0]?.tokensAfter).toBe(14_000)
    expect(w.logs.at(-1)).toContain('120,000 → 14,000 tokens')
  })

  test('the /compact turn does not re-arm an idle session', async ($, on) => {
    const { clock, w } = world(on)
    await startHeadless($, on, w)
    await completeTurn($)
    await clock.advance(51 * MINUTE)
    expect(w.compactions).toBe(1)
    await clock.advance(180 * MINUTE)
    expect(w.compactions).toBe(1)
    await $.turn.start({ text: 'back again', turnId: 't2' })
    await completeTurn($, 't2')
    await clock.advance(51 * MINUTE)
    expect(w.compactions).toBe(2)
  })
})

describe('eligibility', () => {
  test('skips a small context', async ($, on) => {
    const { clock, w } = world(on)
    w.contextTokens = 12_000
    await completeTurn($)
    await clock.advance(51 * MINUTE)
    expect(w.compactions).toBe(0)
    expect(lastReason(w)).toBe('small-context')
  })

  test('skips when the plan limit is used up (5-minute cache on usage credits)', async ($, on) => {
    const { clock, w } = world(on)
    w.rateLimits = [{ kind: 'five_hour', percentUsed: 100 }]
    await completeTurn($)
    await clock.advance(51 * MINUTE)
    expect(w.compactions).toBe(0)
    expect(lastReason(w)).toContain('five_hour limit is used up')
  })

  test('skips when a 5-minute cache TTL is configured', async ($, on) => {
    const { clock, w } = world(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
    await completeTurn($)
    await clock.advance(51 * MINUTE)
    expect(w.compactions).toBe(0)
    expect(lastReason(w)).toBe('short-cache: CLAUDE_CODE_PROMPT_CACHE_TTL is 5m')
  })

  test('skips when settings pin promptCacheTtl to 5m', async ($, on) => {
    const { clock, w } = world(on)
    w.settings = { promptCacheTtl: '5m' }
    await completeTurn($)
    await clock.advance(51 * MINUTE)
    expect(w.compactions).toBe(0)
    expect(lastReason(w)).toBe('short-cache: promptCacheTtl is 5m')
  })

  test('stands down after another compaction of the conversation', async ($, on) => {
    const { clock, w } = world(on)
    await completeTurn($)
    await clock.advance(10 * MINUTE)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
    expect(w.compactions).toBe(1)
    await clock.advance(45 * MINUTE)
    expect(w.compactions).toBe(1)
  })

  test('leaves a conversation fresh from /clear alone', async ($, on) => {
    const { clock, w } = world(on)
    await completeTurn($)
    // After /clear the new conversation has no context reading until its
    // first response.
    w.contextTokens = undefined
    await clock.advance(51 * MINUTE)
    expect(w.compactions).toBe(0)
    expect(lastReason(w)).toBe('small-context')
  })
})

describe('status and log', () => {
  test('records the compaction and reports it through /idle-compactor', async ($, on) => {
    const { clock, w } = world(on)
    await completeTurn($)
    await clock.advance(51 * MINUTE)
    const log = w.store.get('log') as { outcome: string; tokensBefore?: number; tokensAfter?: number }[]
    expect(log.length).toBe(1)
    expect(log[0]?.outcome).toBe('compacted')
    expect(log[0]?.tokensBefore).toBe(120_000)
    expect(log[0]?.tokensAfter).toBe(14_000)
    expect(w.store.get('attempts:2026-09-23')).toBe(1)
    expect(w.logs).toEqual(['idle-compactor: compacted after 50 min idle, while the prompt cache was warm (120,000 → 14,000 tokens)'])
    const { text } = await $.command.run({ command: 'idle-compactor', args: '' })
    expect(text).toContain('compacts after 50 min idle')
    expect(text).toContain('compacted')
  })

  test('the daily cap holds across idle periods', async ($, on) => {
    const { clock, w } = world(on)
    w.store.set('attempts:2026-09-23', 50)
    await completeTurn($)
    await clock.advance(51 * MINUTE)
    expect(w.compactions).toBe(0)
    expect(lastReason(w)).toBe('daily-cap')
  })
})
