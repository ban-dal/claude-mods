import type { SessionRateLimit } from 'claude-code'

import type { History, Sample, WindowHistory } from '../types'
import { formatClock, formatDate, formatPercent, formatTime } from './format'
import type { Palette } from './format'

const MAX_POINTS = 500
// 같은 구간인데 응답마다 리셋 시각이 조금씩 달라지는 것을 같은 구간으로 본다
const SAME_WINDOW_MS = 10 * 60_000
// 값이 그대로여도 이 간격마다 점을 남겨 평평한 구간을 그린다
const FLAT_SAMPLE_MS = 30 * 60_000

export function isHistory(value: unknown): value is History {
  if (!value || typeof value !== 'object') return false
  return Object.values(value).every(
    entry => entry && typeof entry === 'object' && typeof entry.resetsAt === 'string' && Array.isArray(entry.points),
  )
}

export function recordSamples(history: History, limits: SessionRateLimit[], now: number, windows: Record<string, unknown>): History {
  const next: History = { ...history }
  for (const limit of limits) {
    if (!(limit.kind in windows) || limit.resetsAt === undefined) continue
    const resetsAt = Date.parse(limit.resetsAt)
    if (Number.isNaN(resetsAt)) continue

    const existing = next[limit.kind]
    const isSameWindow = existing !== undefined && Math.abs(Date.parse(existing.resetsAt) - resetsAt) < SAME_WINDOW_MS
    const points: Sample[] = isSameWindow ? [...existing.points] : []
    const last = points[points.length - 1]
    if (last === undefined || last[1] !== limit.percentUsed || now - last[0] >= FLAT_SAMPLE_MS) {
      points.push([now, limit.percentUsed])
    }
    next[limit.kind] = { resetsAt: limit.resetsAt, points: points.slice(-MAX_POINTS) }
  }
  return next
}

export type Projection = {
  start: number
  resetsAt: number
  percent: number
  // 구간 시작부터의 평균 속도(%/ms)
  rate: number
  // 지금 속도로 리셋 시점에 예상되는 사용률
  atReset: number
  exhaustsAt?: number
}

export function projectionOf(percent: number, resetsAt: number, windowMs: number, now: number): Projection {
  const start = resetsAt - windowMs
  const elapsed = Math.max(1, now - start)
  const rate = percent / elapsed
  const atReset = percent + rate * Math.max(0, resetsAt - now)
  const exhaustsAt = rate > 0 && percent < 100 ? now + (100 - percent) / rate : undefined
  return { start, resetsAt, percent, rate, atReset, exhaustsAt: exhaustsAt !== undefined && exhaustsAt < resetsAt ? exhaustsAt : undefined }
}

export function describeRate(projection: Projection, windowMs: number): string {
  const perHour = projection.rate * 3_600_000
  return windowMs > 24 * 3_600_000 ? `하루 평균 ${formatPercent(perHour * 24)}` : `시간당 평균 ${formatPercent(perHour)}`
}

export function describeForecast(projection: Projection): string {
  if (projection.exhaustsAt !== undefined) return `지금 속도면 ${formatClock(projection.exhaustsAt)}경 소진`
  return `지금 속도면 리셋 시 ${formatPercent(Math.min(100, projection.atReset))} 예상`
}

const CHART = { width: 372, height: 96, left: 30, right: 10, top: 8, bottom: 20 }

function axisLabel(at: number, windowMs: number): string {
  return windowMs > 24 * 3_600_000 ? formatDate(at) : formatTime(at)
}

export function trendSvg(entry: WindowHistory | undefined, projection: Projection, windowMs: number, now: number, palette: Palette, tone: string): string {
  const plotWidth = CHART.width - CHART.left - CHART.right
  const plotHeight = CHART.height - CHART.top - CHART.bottom
  const x = (at: number) => CHART.left + (Math.min(Math.max(at, projection.start), projection.resetsAt) - projection.start) / windowMs * plotWidth
  const y = (percent: number) => CHART.top + plotHeight * (1 - Math.min(100, Math.max(0, percent)) / 100)
  const point = (at: number, percent: number) => `${x(at).toFixed(1)},${y(percent).toFixed(1)}`

  const points = (entry?.points ?? []).filter(([at]) => at >= projection.start && at <= now)
  const known = [...points, [now, projection.percent] as Sample]
  const [firstAt, firstPercent] = known[0] ?? [now, projection.percent]

  const solid = known.map(([at, percent]) => point(at, percent)).join(' ')
  const area = `${point(firstAt, 0)} ${solid} ${point(now, 0)}`
  // 기록 전 구간은 시작 시점 0%부터 첫 기록까지 점선으로 잇는다
  const before = firstAt > projection.start ? `<polyline points="${point(projection.start, 0)} ${point(firstAt, firstPercent)}" fill="none" stroke="${tone}" stroke-width="1.5" stroke-dasharray="2 3" opacity=".6"/>` : ''
  const forecastEnd = projection.exhaustsAt ?? projection.resetsAt
  const forecastPercent = projection.exhaustsAt !== undefined ? 100 : projection.atReset
  const forecastColor = projection.exhaustsAt !== undefined ? palette.warn : palette.label

  const gridLine = (percent: number, label: string, isLimit = false) =>
    `<line x1="${CHART.left}" x2="${CHART.width - CHART.right}" y1="${y(percent)}" y2="${y(percent)}" stroke="${isLimit ? palette.danger : palette.grid}" stroke-width="1" ${isLimit ? 'stroke-dasharray="3 3" opacity=".55"' : ''}/>` +
    `<text x="${CHART.left - 6}" y="${y(percent) + 3}" font-size="9.5" fill="${palette.label}" text-anchor="end">${label}</text>`
  const timeLabel = (at: number, label: string, anchor: string) =>
    `<text x="${x(at)}" y="${CHART.height - 5}" font-size="9.5" fill="${palette.label}" text-anchor="${anchor}">${label}</text>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART.width}" height="${CHART.height}" viewBox="0 0 ${CHART.width} ${CHART.height}" font-family="-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', system-ui, sans-serif">
${gridLine(0, '0')}${gridLine(50, '50')}${gridLine(100, '100', true)}
<line x1="${x(now)}" x2="${x(now)}" y1="${CHART.top}" y2="${CHART.top + plotHeight}" stroke="${palette.grid}" stroke-width="1"/>
<polygon points="${area}" fill="${tone}" opacity=".16"/>
${before}
<polyline points="${solid}" fill="none" stroke="${tone}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<line x1="${x(now)}" y1="${y(projection.percent)}" x2="${x(forecastEnd)}" y2="${y(forecastPercent)}" stroke="${forecastColor}" stroke-width="1.5" stroke-dasharray="4 3"/>
<circle cx="${x(now)}" cy="${y(projection.percent)}" r="3" fill="${tone}"/>
${timeLabel(projection.start, axisLabel(projection.start, windowMs), 'start')}${timeLabel(now, '지금', 'middle')}${timeLabel(projection.resetsAt, `리셋 ${axisLabel(projection.resetsAt, windowMs)}`, 'end')}
</svg>`
}

const SPARK = '▁▂▃▄▅▆▇█'

// 터미널용: 구간 시작부터 지금까지를 cells 칸으로 나눠 각 칸 끝의 사용률을 막대 높이로 그린다
export function sparkline(entry: WindowHistory | undefined, projection: Projection, now: number, cells: number): string {
  const points: Sample[] = [[projection.start, 0], ...(entry?.points ?? []), [now, projection.percent]]
  const span = Math.max(1, now - projection.start)
  let line = ''
  for (let cell = 1; cell <= cells; cell++) {
    const at = projection.start + (span * cell) / cells
    const value = points.filter(([sampleAt]) => sampleAt <= at).pop()?.[1] ?? 0
    line += SPARK[Math.min(SPARK.length - 1, Math.floor((value / 100) * SPARK.length))] ?? SPARK[0]
  }
  return line
}
