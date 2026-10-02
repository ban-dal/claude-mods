export type Tone = 'ok' | 'warn' | 'danger' | 'idle'

export type Palette = { label: string; value: string; track: string; surface: string; border: string; grid: string } & Record<Tone, string>

export const PALETTE: Record<'dark' | 'light', Palette> = {
  dark: {
    label: '#a1a1aa',
    value: '#f4f4f5',
    track: '#3f3f46',
    surface: '#1c1c20',
    border: '#3f3f46',
    grid: '#2e2e34',
    ok: '#818cf8',
    warn: '#fbbf24',
    danger: '#f87171',
    idle: '#71717a',
  },
  light: {
    label: '#71717a',
    value: '#18181b',
    track: '#e4e4e7',
    surface: '#ffffff',
    border: '#d4d4d8',
    grid: '#ececef',
    ok: '#4f46e5',
    warn: '#b45309',
    danger: '#dc2626',
    idle: '#a1a1aa',
  },
}

export function toneOf(percent: number | undefined): Tone {
  if (percent === undefined) return 'idle'
  if (percent >= 90) return 'danger'
  if (percent >= 80) return 'warn'
  return 'ok'
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

export function formatRemaining(ms: number, isShort: boolean): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (isShort) {
    if (days > 0) return `${days}d${hours}h`
    return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`
  }
  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`
  if (hours > 0) return `${hours}시간 ${minutes % 60}분`
  return `${minutes}분`
}

export function formatTime(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatClock(at: number): string {
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(at).getDay()]
  return weekday === undefined ? formatTime(at) : `${weekday} ${formatTime(at)}`
}

export function formatDate(at: number): string {
  const date = new Date(at)
  return `${date.getMonth() + 1}/${date.getDate()} ${formatTime(at)}`
}

export function formatPercent(percent: number): string {
  return percent >= 10 || percent === 0 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`
}

export function barSvg(percent: number, width: number, fill: string, track: string): string {
  const filled = Math.min(1, Math.max(0, percent / 100)) * width
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6"><rect width="${width}" height="6" rx="3" fill="${track}"/>${
    filled > 0 ? `<rect width="${Math.max(6, filled)}" height="6" rx="3" fill="${fill}"/>` : ''
  }</svg>`
}

export function textBar(percent: number, cells: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells)
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

// Desktop 에서 픽셀 단위 간격을 만드는 투명 SVG: 그리는 내용이 없으면 크기 없이 접히므로 투명 사각형을 둔다
export function spacerSvg(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#000" fill-opacity="0"/></svg>`
}
