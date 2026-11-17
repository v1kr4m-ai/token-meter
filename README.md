# token-meter

A Claude Code mod that shows how many tokens you are using, live, in the footer
beside the model picker, and a small usage card with the breakdown.

```
🔶 5h 128M  🔷 wk 676M  ⚡ ↓1.2k
```

- **🔶 5h** – tokens used in your current 5-hour usage window, across every
  Claude Code session on this computer (CLI and desktop app).
- **🔷 wk** – the same for the current week.
- **⚡ ↓1.2k** – while Claude works: a live count of what it is writing this reply.
  **💤** when idle, with this session's output so far.

Run **`/tokens`** to open the usage card (a small floating widget on the desktop
app, a side pane elsewhere):

- each window's total and when it resets
- the split by token type, each in its own colour: **output**, **cache writes**,
  **cache reads**, **new input**
- this session's output and context size
- the full pane adds a per-model table for both windows and a Refresh button

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install token-meter --marketplace v1kr4m-ai/token-meter
```

Answer `y` to add the marketplace, then pick a scope (user scope = every session).

From a shell:

```bash
claude plugin install token-meter --marketplace v1kr4m-ai/token-meter
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with `v1kr4m-ai/token-meter`,
then **Add plugin**.

Already-open sessions pick it up after `/reload-plugins`.

### Requirements

- A Claude Code version that loads hooks-module plugins (mods).
- **Node.js** on your `PATH` – the totals are counted by a small Node script
  (`hooks/usage-scan.mjs`, no dependencies).

## How it counts

- **Live count** – estimated from the reply as it streams (~4 characters per
  token), then replaced by the exact `output_tokens` the API reports for each step.
- **5-hour and weekly totals** – summed from the conversation logs Claude Code
  already keeps in `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR/projects`).
  Each API response is counted once. The window starts are taken from your plan's
  reset times when Claude Code reports them, otherwise the last 5 hours / 7 days.
  Recounted when a session starts and after each reply (about 1–2 seconds).
- **Cache reads** are included: on a long conversation every reply re-reads the
  whole history from cache, so they are usually the largest number. They are
  much cheaper than new input; cache **writes** (rebuilding a conversation's
  cache after switching model, a break of over an hour, or resuming an old
  session) weigh far more per token.
- Non-Claude models (e.g. local Ollama models routed through Claude Code) appear
  in the per-model table marked `(local)` and are left out of the card's split.

## Privacy and cost

- Everything runs on your computer. Nothing is sent anywhere.
- The mod makes no model calls. The footer and card are shown only to you and
  never sent to Claude; the only thing Claude sees is the one-line description
  of the `/tokens` command (about 20 tokens per session).

## Limits

- The footer slot beside the model picker accepts plain text only, so colour
  there comes from emoji, and it cannot be clicked: use `/tokens`.
- Anthropic does not publish how plan limits weigh each token type, so the
  totals are raw token counts, not a percentage of your limit.

## Uninstall

```bash
claude plugin uninstall token-meter
```

## License

MIT
