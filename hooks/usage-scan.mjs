// Sums token usage per model from Claude Code transcripts (~/.claude/projects/**/*.jsonl),
// covering every session on this machine: CLI and desktop app alike.
// Usage: node usage-scan.mjs <window-name>=<since-ms> ...   -> JSON on stdout
// Each assistant message is counted once (message.id + requestId), as transcripts
// repeat a message across streamed chunks and resumed sessions.
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

const windows = process.argv.slice(2).map(a => {
  const [name, since] = a.split('=')
  return { name, since: Number(since) }
})
const oldest = Math.min(...windows.map(w => w.since))
const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')

function files(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) files(p, out)
    else if (e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= oldest) out.push(p)
  }
  return out
}

const result = Object.fromEntries(windows.map(w => [w.name, {}]))
const seen = new Set()

for (const f of files(root)) {
  const lines = createInterface({ input: createReadStream(f), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.includes('"usage"')) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    const u = m?.message?.usage
    const model = m?.message?.model
    if (!u || !model || model === '<synthetic>') continue
    const t = Date.parse(m.timestamp)
    if (!(t >= oldest)) continue
    const key = `${m.message.id}:${m.requestId}`
    if (seen.has(key)) continue
    seen.add(key)
    for (const w of windows) {
      if (t < w.since) continue
      const s = (result[w.name][model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, calls: 0 })
      s.input += u.input_tokens || 0
      s.output += u.output_tokens || 0
      s.cacheRead += u.cache_read_input_tokens || 0
      s.cacheWrite += u.cache_creation_input_tokens || 0
      s.cacheWrite1h += u.cache_creation?.ephemeral_1h_input_tokens || 0
      s.calls += 1
    }
  }
}

process.stdout.write(JSON.stringify(result))
