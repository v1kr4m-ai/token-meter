export type Meter = { line: string; isLive: boolean }

export type ModelTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; calls: number }

export type UsageWindow = { since: number; models: Record<string, ModelTotals> }

export type Usage = {
  scannedAt: number
  fiveHour: UsageWindow
  week: UsageWindow
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Session = { output: number; context: number; usd?: number }

declare module 'claude-code' {
  interface PluginState {
    'token-meter': {
      meter: Meter | null
      session: Session
      limits: Limit[]
      usage: Shaped<Usage | null>
      scanError: string | null
      isScanning: boolean
    }
  }
}
