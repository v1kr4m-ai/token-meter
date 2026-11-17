import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Meter, ModelTotals, Session, Usage, UsageWindow } from '../types'

// ponytail: ~4 chars per token while streaming; replaced by the API's exact
// output_tokens when each step finishes.
const CHARS_PER_TOKEN = 4
const HOUR = 3_600_000
const PANE = 'token-usage'

const meter = atom({ plugin: 'token-meter', key: 'meter' } as const, null)
const session = atom({ plugin: 'token-meter', key: 'session' } as const, { output: 0, context: 0 })
const limits = atom({ plugin: 'token-meter', key: 'limits' } as const, [])
const usage = atom({ plugin: 'token-meter', key: 'usage' } as const, null, { shape: 'usage-2' })
const scanError = atom({ plugin: 'token-meter', key: 'scanError' } as const, null)
const isScanning = atom({ plugin: 'token-meter', key: 'isScanning' } as const, false)

const fmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`

const total = (t: ModelTotals) => t.input + t.output + t.cacheRead + t.cacheWrite

function untilText(resetsAt: string | undefined, now: number) {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (!(at > now)) return ''
  const mins = Math.round((at - now) / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  return `resets in ${d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`}`
}

function limitOf(list: readonly Limit[], kind: string) {
  return list.find(l => l.kind === kind)
}

let shown = '' // last band line, to skip redundant redraws
let scanning = false

const sumOf = (w: UsageWindow | undefined) =>
  Object.values(w?.models ?? {}).reduce((acc, t) => acc + total(t), 0)

// The footer text beside the model picker (the one spot a mod can write there):
// actual token counts, all sessions: current 5-hour window, current week, then
// this reply's live count (or this session's output when idle).
async function footer($: EngineInterface) {
  const s = await read($, session)
  const m = await read($, meter)
  const u = await read($, usage)
  const figure = m?.isLive ? (m.line.match(/~?[\d.]+[kMB]?/)?.[0] ?? '0') : fmt(s.output)
  const windows = u ? `🔶 5h ${fmt(sumOf(u.fiveHour))}  🔷 wk ${fmt(sumOf(u.week))}  ` : ''
  $.ui.status(`${windows}${m?.isLive ? '⚡' : '💤'} ↓${figure}`)
}

async function show($: EngineInterface, line: string, isLive: boolean) {
  if (line === shown) return
  shown = line
  await update($, meter, (): Meter => ({ line, isLive }))
  await footer($)
}

const levelColor = (pct: number) => (pct >= 90 ? '#E5484D' : pct >= 70 ? '#F5A524' : '#3DD68C')

// A hexagonal "chip": left bar = 5-hour window, right bar = week, core pulses while working.
function chipSvg(five: number | undefined, week: number | undefined, isLive: boolean) {
  const bar = (x: number, pct: number | undefined) => {
    const p = Math.max(0, Math.min(100, pct ?? 0))
    const h = (p / 100) * 9
    return `<rect x="${x}" y="6.5" width="2.2" height="9" rx="1" fill="#8884"/>` +
      (pct === undefined ? '' : `<rect x="${x}" y="${15.5 - h}" width="2.2" height="${h}" rx="1" fill="${levelColor(p)}"/>`)
  }
  const pulse = isLive
    ? `<animate attributeName="r" values="1.2;2.2;1.2" dur="1.2s" repeatCount="indefinite"/>` +
      `<animate attributeName="opacity" values="1;0.4;1" dur="1.2s" repeatCount="indefinite"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" width="22" height="22">` +
    `<path d="M11 1.5 19.5 6.25v9.5L11 20.5 2.5 15.75v-9.5Z" fill="none" stroke="#D97757" stroke-width="1.4" stroke-linejoin="round"/>` +
    `<path d="M11 1.5v2.2M19.5 6.25l-1.9 1.1M19.5 15.75l-1.9-1.1M11 20.5v-2.2M2.5 15.75l1.9-1.1M2.5 6.25l1.9 1.1" stroke="#D97757" stroke-width="1" opacity="0.7"/>` +
    bar(6.6, five) + bar(13.2, week) +
    `<circle cx="11" cy="11" r="1.2" fill="${isLive ? '#D97757' : '#8888'}">${pulse}</circle>` +
    `</svg>`
}

async function measure($: EngineInterface) {
  const u = await $.session.usage()
  await update($, limits, (): Limit[] => u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })))
  await update($, session, (s): Session => ({ ...s, usd: u.cost?.usd }))
  await footer($)
}

// Sums every session's transcripts on this machine (CLI and desktop) per model.
async function scan($: EngineInterface) {
  if (scanning) return
  scanning = true
  await update($, isScanning, () => true)
  try {
    const now = await $.clock.now()
    const lim = await read($, limits)
    const start = (kind: string, span: number) => {
      const at = Date.parse(limitOf(lim, kind)?.resetsAt ?? '')
      return at > now ? at - span : now - span
    }
    const fiveSince = start('five_hour', 5 * HOUR)
    const weekSince = start('seven_day', 168 * HOUR)
    const r = await $.process.run(
      ['node', `${$.plugin.root}/hooks/usage-scan.mjs`, `fiveHour=${fiveSince}`, `week=${weekSince}`],
      { timeoutMs: 120_000 },
    )
    if (r.exitCode !== 0) throw new Error(r.stderr.slice(0, 300) || `exit ${r.exitCode}`)
    const out = JSON.parse(r.stdout) as Record<string, UsageWindow['models']>
    await update($, usage, (): Usage => ({
      scannedAt: now,
      fiveHour: { since: fiveSince, models: out.fiveHour ?? {} },
      week: { since: weekSince, models: out.week ?? {} },
    }))
    await update($, scanError, () => null)
    await footer($)
  } catch (err) {
    await update($, scanError, () => String(err instanceof Error ? err.message : err))
  } finally {
    scanning = false
    await update($, isScanning, () => false)
  }
}

async function openPane($: EngineInterface) {
  // a widget is the desktop's small floating card: the closest a mod gets to a pop-up
  await $.ui.open({ id: PANE, title: 'Token usage', placement: 'widget' })
  void scan($)
}

export const register: Register = on => {
  let stepsDone = 0 // exact output tokens of this turn's finished steps

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tokens', description: 'Open the token usage panel (5-hour, weekly, per model)' })
    void measure($).then(() => scan($))
    return next(e)
  })

  on('command.run', { command: 'tokens' }, async $ => {
    await openPane($)
    return { text: 'Token usage panel opened.' }
  })

  on('session.measure', async ($, e, next) => {
    await measure($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    stepsDone = 0
    await show($, '↓ 0 tokens · thinking', true)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let chars = 0
    let phase = 'thinking'
    const stream = next(e)
    for await (const c of stream) {
      if (c.kind === 'text' || c.kind === 'thinking' || c.kind === 'input') {
        chars += c.kind === 'input' ? c.json.length : c.text.length
        phase = c.kind === 'text' ? 'writing' : c.kind === 'thinking' ? 'thinking' : phase
      } else if (c.kind === 'tool') {
        phase = `calling ${c.name}`
      }
      // rounded to 10 tokens so the band redraws a few times a second, not per chunk
      const est = Math.floor((stepsDone + chars / CHARS_PER_TOKEN) / 10) * 10
      await show($, `↓ ~${fmt(est)} tokens · ${phase}`, true)
      yield c
    }
    const r = await stream.result
    const out = r?.usage ? r.usage.output_tokens : chars / CHARS_PER_TOKEN
    stepsDone += out
    const context = r?.usage
      ? r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens
      : undefined
    await update($, session, (s): Session => ({ ...s, output: s.output + out, context: context ?? s.context }))
    await show($, `↓ ${fmt(stepsDone)} tokens · step ${e.index + 1} done`, true)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const s = await read($, session)
    await show($, `Last turn ↓ ${fmt(stepsDone)} · session ↓ ${fmt(s.output)} · context ${fmt(s.context)}`, false)
    void measure($).then(() => scan($))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const lim = await read($, limits)
    const s = await read($, session)
    const u = await read($, usage)
    const err = await read($, scanError)
    const busy = await read($, isScanning)

    const bar = (pct: number) => {
      const n = Math.max(0, Math.min(20, Math.round(pct / 5)))
      return '█'.repeat(n) + '░'.repeat(20 - n)
    }

    const limitRow = (title: string, l: Limit | undefined) => (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{title}</Text>
        {l ? (
          <Text>
            <Text color={l.percentUsed >= 90 ? 'error' : l.percentUsed >= 70 ? 'warning' : 'claude'}>{bar(l.percentUsed)}</Text>
            {`  ${l.percentUsed}% used  `}
            <Text dimColor>{untilText(l.resetsAt, now)}</Text>
          </Text>
        ) : (
          <Text dimColor>No reading yet (shows after the next reply on a subscription).</Text>
        )}
      </Box>
    )

    const table = (title: string, w: UsageWindow | undefined) => {
      const rows = Object.entries(w?.models ?? {}).sort((a, b) => total(b[1]) - total(a[1]))
      const sum = rows.reduce((acc, [, t]) => acc + total(t), 0)
      const sumOut = rows.reduce((acc, [, t]) => acc + t.output, 0)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{title}</Text>
          {rows.length === 0 ? (
            <Text dimColor>{u ? 'No usage in this window.' : busy ? 'Counting…' : 'Not counted yet.'}</Text>
          ) : (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Box width={22}><Text dimColor>Model</Text></Box>
                <Box width={10}><Text dimColor>Output</Text></Box>
                <Box width={10}><Text dimColor>Total*</Text></Box>
                <Box width={8}><Text dimColor>Calls</Text></Box>
              </Box>
              {rows.map(([model, t]) => (
                <Box flexDirection="row">
                  <Box width={22}>
                    <Text>{model.replace(/^claude-/, '')}{model.startsWith('claude-') ? '' : ' (local)'}</Text>
                  </Box>
                  <Box width={10}><Text>{fmt(t.output)}</Text></Box>
                  <Box width={10}><Text>{fmt(total(t))}</Text></Box>
                  <Box width={8}><Text>{t.calls}</Text></Box>
                </Box>
              ))}
              <Box flexDirection="row">
                <Box width={22}><Text bold>All models</Text></Box>
                <Box width={10}><Text bold>{fmt(sumOut)}</Text></Box>
                <Box width={10}><Text bold>{fmt(sum)}</Text></Box>
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    const ago = u ? Math.max(0, Math.round((now - u.scannedAt) / 60_000)) : 0

    // Minimized as a widget: a compact card, like the model picker's pop-up.
    if (e.props.placement === 'widget') {
      const five = limitOf(lim, 'five_hour')
      const week = limitOf(lim, 'seven_day')
      const ui = $.ui.resolve(e)
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            {'Svg' in ui ? (
              <ui.Svg source={chipSvg(five?.percentUsed, week?.percentUsed, false)} alt="Token usage" width={20} height={20} />
            ) : null}
            <Text bold>Usage</Text>
          </Box>
          {[['5-hour', u?.fiveHour, five?.resetsAt], ['Week', u?.week, week?.resetsAt]].map(([name, w, resets]) => {
            const win = w as UsageWindow | undefined
            const counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            for (const [model, t] of Object.entries(win?.models ?? {})) {
              if (!model.startsWith('claude-')) continue // local models don't touch the plan
              for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) counts[k] += t[k]
            }
            const all = counts.input + counts.output + counts.cacheRead + counts.cacheWrite
            const row = (label: string, k: keyof typeof counts, color: string) => (
              <Box flexDirection="row">
                <Box width={14}><Text color={color}>{`● ${label}`}</Text></Box>
                <Box width={9}><Text bold color={color}>{fmt(counts[k])}</Text></Box>
              </Box>
            )
            return (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={name === 'Week' ? '#5B9BFF' : '#D97757'}>{`${name === 'Week' ? '🔷' : '🔶'} ${name as string}  ${fmt(all)} tokens `}<Text dimColor>{untilText(resets as string | undefined, now)}</Text></Text>
                {row('Output', 'output', '#D97757')}
                {row('Cache writes', 'cacheWrite', '#F5A524')}
                {row('Cache reads', 'cacheRead', '#3DD68C')}
                {row('New input', 'input', '#5B9BFF')}
              </Box>
            )
          })}
          <Text dimColor>{`Session ↓${fmt(s.output)} · ctx ${fmt(s.context)}`}</Text>
          <Text dimColor>Claude models only; local models don't touch your plan.</Text>
          <Button key="refresh" label={busy ? 'Counting…' : 'Refresh'} onPress={() => scan($)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="claude">Plan limits</Text>
        {limitRow('5-hour window', limitOf(lim, 'five_hour'))}
        {limitRow('Weekly', limitOf(lim, 'seven_day'))}

        <Text bold color="claude">This session</Text>
        <Box flexDirection="column" marginBottom={1}>
          <Text>{`Output ↓ ${fmt(s.output)} · context ${fmt(s.context)}`}</Text>
        </Box>

        <Text bold color="claude">All sessions on this computer</Text>
        {table('Current 5-hour window', u?.fiveHour)}
        {table('Current week', u?.week)}
        <Text dimColor>* Total = input + output + cache reads + cache writes. Cache reads are cheap but counted.</Text>
        {err && <Text color="error">Count failed: {err}</Text>}
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Button key="refresh" label={busy ? 'Counting…' : 'Refresh'} onPress={() => scan($)} />
          <Text dimColor>{u ? `Counted ${ago === 0 ? 'just now' : `${ago} min ago`}` : ''}</Text>
        </Box>
      </Box>
    )
  })
}
