export type Palette = {
  label: string
  value: string
  muted: string
  border: string
  surface: string
  track: string
  active: string
  success: string
  warn: string
  danger: string
}

export const PALETTE: Record<'dark' | 'light', Palette> = {
  dark: {
    label: '#a1a1aa',
    value: '#f4f4f5',
    muted: '#71717a',
    border: '#3f3f46',
    surface: '#1c1c20',
    track: '#3f3f46',
    active: '#818cf8',
    success: '#4ade80',
    warn: '#fbbf24',
    danger: '#f87171',
  },
  light: {
    label: '#71717a',
    value: '#18181b',
    muted: '#a1a1aa',
    border: '#d4d4d8',
    surface: '#ffffff',
    track: '#e4e4e7',
    active: '#4f46e5',
    success: '#16a34a',
    warn: '#b45309',
    danger: '#dc2626',
  },
}

// 단계 수만큼 나눈 진행 막대 (Desktop)
export function stepsSvg(count: number, current: number, width: number, palette: Palette): string {
  const gap = 4
  const segment = (width - gap * (count - 1)) / count
  const rects = Array.from({ length: count }, (_, index) => {
    const fill = index < current ? palette.active : index === current ? palette.active : palette.track
    const opacity = index === current ? ' fill-opacity="0.55"' : ''
    const x = (segment + gap) * index
    return `<rect x="${x.toFixed(1)}" y="0" width="${segment.toFixed(1)}" height="4" rx="2" fill="${fill}"${opacity}/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="4" viewBox="0 0 ${width} 4">${rects.join('')}</svg>`
}
