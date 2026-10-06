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

// 미터 줄 항목별 고유색: 경고·위험색(amber, red)과 겹치지 않게 고른다
export const ACCENT: Record<'dark' | 'light', Record<string, string>> = {
  dark: { context: '#a78bfa', cache: '#2dd4bf', five_hour: '#60a5fa', seven_day: '#4ade80', cost: '#f472b6' },
  light: { context: '#7c3aed', cache: '#0d9488', five_hour: '#2563eb', seven_day: '#16a34a', cost: '#db2777' },
}

// 24×24 선 아이콘 (Lucide: pie-chart, zap, gauge, calendar, circle-dollar-sign, history, hourglass)
const ICON_PATHS: Record<string, string> = {
  context: '<path d="M21 12c.55 0 1-.45.95-1A10 10 0 0 0 13 2.05c-.55-.05-1 .4-1 .95v8a1 1 0 0 0 1 1z"/><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/>',
  cache: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  five_hour: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  seven_day: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  cost: '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 18V6"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  hourglass:
    '<path d="M5 22h14M5 2h14"/><path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22"/><path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>',
}

// terminal용: 모두 한 칸 폭이고 이모지로 그려지지 않는 글자. 없는 아이콘은 그리지 않는다
export const ICON_GLYPH: Record<string, string> = { context: '◔', cache: '↯', five_hour: '◷', seven_day: '▦', cost: '$' }

export type ChipPart =
  | { kind: 'icon'; id: string; color: string }
  | { kind: 'text'; text: string; color: string; isBold?: boolean }
  // marker: 구간 경과 비율(0~1)
  | { kind: 'bar'; percent: number; color: string; marker?: number }
  | { kind: 'divider' }

// ink: 글자색. 막대 바탕과 경과 마커를 이 색으로 그려 어느 칩 배경에서도 보이게 한다
export type ChipStyle = { tint: string; tintOpacity: number; divider: string; ink: string }

export const CHIP_HEIGHT = 22
const CHIP_PAD = 8
const CHIP_GAP = 5
const CHIP_FONT = 12
const CHIP_ICON = 14
const CHIP_BAR = 36
const CHIP_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 고정폭 글꼴 기준: 라틴 0.6em, 한글 같은 넓은 글자 1em
function textWidth(text: string): number {
  return [...text].reduce((width, char) => width + (char.charCodeAt(0) >= 0x1100 ? 1 : 0.6), 0) * CHIP_FONT
}

// 둥근 알약 모양 칩 하나: 아이콘, 글자, 막대, 구분선을 왼쪽부터 늘어놓는다
export function chipSvg(parts: ChipPart[], style: ChipStyle): { source: string; width: number } {
  const mid = CHIP_HEIGHT / 2
  const body: string[] = []
  let x = CHIP_PAD
  parts.forEach((part, index) => {
    if (index > 0) x += CHIP_GAP
    if (part.kind === 'icon') {
      body.push(
        `<g transform="translate(${x} ${mid - CHIP_ICON / 2}) scale(${CHIP_ICON / 24})" fill="none" stroke="${part.color}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[part.id] ?? ''}</g>`,
      )
      x += CHIP_ICON
    } else if (part.kind === 'text') {
      body.push(
        `<text x="${x}" y="${mid}" dominant-baseline="central" font-family="${CHIP_FAMILY}" font-size="${CHIP_FONT}" font-weight="${part.isBold ? 600 : 400}" fill="${part.color}">${escapeXml(part.text)}</text>`,
      )
      x += textWidth(part.text)
    } else if (part.kind === 'bar') {
      const filled = Math.min(1, Math.max(0, part.percent / 100)) * CHIP_BAR
      body.push(`<rect x="${x}" y="${mid - 3}" width="${CHIP_BAR}" height="6" rx="3" fill="${style.ink}" fill-opacity="0.18"/>`)
      if (filled > 0) body.push(`<rect x="${x}" y="${mid - 3}" width="${Math.max(6, filled)}" height="6" rx="3" fill="${part.color}"/>`)
      if (part.marker !== undefined) {
        const at = x + Math.min(1, Math.max(0, part.marker)) * CHIP_BAR
        body.push(`<line x1="${at}" y1="${mid - 6}" x2="${at}" y2="${mid + 6}" stroke="${style.ink}" stroke-width="1.5" stroke-linecap="round"/>`)
      }
      x += CHIP_BAR
    } else {
      body.push(`<line x1="${x}" y1="${mid - 6}" x2="${x}" y2="${mid + 6}" stroke="${style.divider}" stroke-width="1"/>`)
      x += 1
    }
  })
  const width = Math.ceil(x + CHIP_PAD)
  return {
    width,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CHIP_HEIGHT}" viewBox="0 0 ${width} ${CHIP_HEIGHT}"><rect width="${width}" height="${CHIP_HEIGHT}" rx="${mid}" fill="${style.tint}" fill-opacity="${style.tintOpacity}"/>${body.join('')}</svg>`,
  }
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
