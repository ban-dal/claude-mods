export type Meter = {
  id: string
  label: string
  percent?: number
  // 한도 구간만 있음
  resetsAt?: string
  windowMs?: number
  // 컨텍스트만 있음
  tokens?: number
  capacity?: number
}

export type Snapshot = { meters: Meter[] }

// /context 의 한 줄: color 는 Claude Code 테마 키
export type Slice = { name: string; tokens: number; color: string }

export type Breakdown = { used: Slice[]; freeTokens: number; bufferTokens: number }

// [기록 시각(ms), 사용률(%)]
export type Sample = [number, number]

export type WindowHistory = { resetsAt: string; points: Sample[] }

// 한도 종류(five_hour, seven_day)별 현재 구간의 기록
export type History = Record<string, WindowHistory>

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      snapshot: Snapshot | null
      breakdown: Breakdown | null
      history: History
      isDark: boolean
      isHidden: boolean
      // 열린 패널의 미터 id (context, five_hour, seven_day)
      openPanel: string | null
      alerted: string[]
    }
  }
}
