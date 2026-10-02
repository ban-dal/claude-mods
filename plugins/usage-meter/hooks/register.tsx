import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderSurface, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Breakdown, Meter, Slice, Snapshot } from '../types'
import { barSvg, formatClock, formatRemaining, formatTokens, PALETTE, spacerSvg, textBar, toneOf } from './format'
import type { Tone } from './format'
import { describeForecast, describeRate, isHistory, projectionOf, recordSamples, sparkline, trendSvg } from './trend'
import type { Projection } from './trend'

const snapshot = atom({ plugin: 'usage-meter', key: 'snapshot' } as const, null)
const breakdown = atom({ plugin: 'usage-meter', key: 'breakdown' } as const, null)
const history = atom({ plugin: 'usage-meter', key: 'history' } as const, {})
const isDark = atom({ plugin: 'usage-meter', key: 'isDark' } as const, true)
const isHidden = atom({ plugin: 'usage-meter', key: 'isHidden' } as const, false)
const openPanel = atom({ plugin: 'usage-meter', key: 'openPanel' } as const, null)
const alerted = atom({ plugin: 'usage-meter', key: 'alerted' } as const, [])

const COMMAND = 'usage-meter'
const HOUR = 3_600_000

const WINDOWS: Record<string, { label: string; short: string; windowMs: number }> = {
  five_hour: { label: '세션', short: '5h', windowMs: 5 * HOUR },
  seven_day: { label: '주간', short: '7d', windowMs: 7 * 24 * HOUR },
}
const ORDER = ['context', 'five_hour', 'seven_day']

const SLICE_LABEL: Record<string, string> = {
  'System prompt': '시스템 프롬프트',
  'System tools': '시스템 도구',
  'MCP tools': 'MCP 도구',
  'Custom agents': '커스텀 에이전트',
  'Memory files': '메모리 파일',
  Skills: '스킬',
  Messages: '대화 메시지',
}

const LIMIT_THRESHOLDS = [90, 80]
const CONTEXT_THRESHOLD = 90
const PANEL_ROWS = 8
const PANEL_WIDTH = 46
const NAME_WIDTH = 16
// 패널과 미터 줄 사이 간격 (Desktop, px)
const PANEL_GAP = 8
// 구간이 이만큼 지나기 전에는 소진 예상을 띄우지 않는다
const FORECAST_MIN_ELAPSED = 0.1

function toSnapshot(context: SessionContextUsage, limits: SessionRateLimit[]): Snapshot {
  const meters: Meter[] = [
    { id: 'context', label: '컨텍스트', percent: context.percent, tokens: context.tokens, capacity: context.window },
    ...limits.map(limit => ({
      id: limit.kind,
      label: WINDOWS[limit.kind]?.label ?? (limit.kind === 'spend_limit' ? '지출 한도' : limit.kind),
      percent: limit.percentUsed,
      resetsAt: limit.resetsAt,
      windowMs: WINDOWS[limit.kind]?.windowMs,
    })),
  ]
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length)
  return { meters: meters.sort((a, b) => rank(a.id) - rank(b.id)) }
}

function toBreakdown(context: SessionContextUsage): Breakdown | null {
  const categories = context.breakdown?.categories
  if (categories === undefined) return null
  const sum = (kind: string) => categories.filter(c => c.kind === kind).reduce((total, c) => total + c.tokens, 0)
  return {
    used: categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(c => ({ name: SLICE_LABEL[c.name] ?? c.name, tokens: c.tokens, color: c.color }))
      .sort((a, b) => b.tokens - a.tokens),
    freeTokens: sum('free'),
    bufferTokens: sum('buffer'),
  }
}

type Reading = {
  percent?: number
  tone: Tone
  remainingMs?: number
  projection?: Projection
  // 미터 줄에 띄울 소진 예상 시각
  exhaustsAt?: number
}

function readingOf(meter: Meter, now: number): Reading {
  const reading: Reading = { percent: meter.percent, tone: toneOf(meter.percent) }
  const resetsAt = meter.resetsAt === undefined ? NaN : Date.parse(meter.resetsAt)
  if (Number.isNaN(resetsAt)) return reading

  reading.remainingMs = Math.max(0, resetsAt - now)
  if (meter.percent === undefined || meter.windowMs === undefined) return reading

  reading.projection = projectionOf(meter.percent, resetsAt, meter.windowMs, now)
  const elapsed = (meter.windowMs - reading.remainingMs) / meter.windowMs
  if (elapsed >= FORECAST_MIN_ELAPSED) reading.exhaustsAt = reading.projection.exhaustsAt
  return reading
}

async function refreshTheme($: EngineInterface) {
  const rows = await $.config.list().catch(() => [])
  const theme = rows.find(row => row.key === 'theme')?.value
  if (typeof theme === 'string') await update($, isDark, () => !theme.startsWith('light'))
}

async function recordHistory($: EngineInterface, limits: SessionRateLimit[]) {
  if (limits.length === 0) return
  const now = await $.clock.now()
  const saved = await update($, history, current => recordSamples(current, limits, now, WINDOWS))
  await $.store.set('history', saved).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: '사용량 미터 표시/숨기기' })
    if ((await $.store.get('isHidden')) === true) await update($, isHidden, () => true)
    const stored = await $.store.get('history')
    if (isHistory(stored)) await update($, history, () => stored)
    await refreshTheme($)

    const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => $.session.usage())
    await update($, snapshot, () => toSnapshot(usage.context, usage.rateLimits))
    await update($, breakdown, () => toBreakdown(usage.context))
    await recordHistory($, usage.rateLimits)

    // 리셋까지 남은 시간과 소진 예상 표시를 갱신한다
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    await refreshTheme($)
    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    const hidden = await update($, isHidden, value => !value)
    await $.store.set('isHidden', hidden)
    return { text: hidden ? '사용량 미터를 숨겼습니다. 다시 보려면 /usage-meter' : '사용량 미터를 표시합니다.' }
  })

  on('session.measure', async ($, e, next) => {
    await update($, snapshot, () => toSnapshot(e.context, e.rateLimits))
    if (e.changed.includes('context')) {
      const detailed = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
      if (detailed) await update($, breakdown, () => toBreakdown(detailed.context))
    }
    if (e.changed.includes('rateLimits')) await recordHistory($, e.rateLimits)

    const sent = await read($, alerted)
    const now = await $.clock.now()
    const fresh: string[] = []

    for (const limit of e.rateLimits) {
      const threshold = LIMIT_THRESHOLDS.find(t => limit.percentUsed >= t)
      if (threshold === undefined) continue
      const id = `${limit.kind}:${limit.resetsAt ?? ''}:${threshold}`
      if (sent.includes(id)) continue
      fresh.push(id)
      const label = WINDOWS[limit.kind]?.label ?? limit.kind
      const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
      const suffix = Number.isNaN(resetsAt) ? '' : ` · ${formatRemaining(resetsAt - now, false)} 후 리셋`
      $.ui.toast(`${label} 한도 ${limit.percentUsed}% 사용${suffix}`)
    }

    // 컨텍스트 경고는 compact/clear로 내려가면 다시 받을 수 있게 지운다
    const contextPercent = e.context.percent ?? 0
    const kept = contextPercent < CONTEXT_THRESHOLD - 20 ? sent.filter(id => !id.startsWith('context:')) : sent
    if (contextPercent >= CONTEXT_THRESHOLD && !kept.includes('context:90')) {
      fresh.push('context:90')
      $.ui.toast(`컨텍스트 ${contextPercent}% 사용 · /compact 를 고려하세요`)
    }

    if (fresh.length > 0 || kept.length !== sent.length) await update($, alerted, () => [...kept, ...fresh])
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, snapshot)
    if (e.props.hasSurvey || current === null || (await read($, isHidden))) return next(e)

    const table: ElementTable<RenderSurface> = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const palette = PALETTE[(await read($, isDark)) ? 'dark' : 'light']
    const slices = await read($, breakdown)
    const records = await read($, history)
    const opened = await read($, openPanel)
    const now = await $.clock.now()
    const isShort = Svg === undefined
    const isNarrow = e.props.bodyColumns < 90

    const toggle = (id: string) => () => update($, openPanel, value => (value === id ? null : id))
    const close = () => update($, openPanel, () => null)

    const readings = current.meters.map(meter => ({ meter, reading: readingOf(meter, now) }))
    const canOpen = (meter: Meter, reading: Reading) =>
      meter.id === 'context' ? slices !== null && meter.capacity !== undefined && meter.tokens !== undefined : reading.projection !== undefined

    const bar = (key: string, percent: number | undefined, tone: Tone, width: number, cells: number) => {
      if (percent === undefined) return null
      if (Svg) {
        return <Svg key={key} source={barSvg(percent, width, palette[tone], palette.track)} alt={`${Math.round(percent)}%`} width={width} height={6} />
      }
      return (
        <Text key={key} color={palette[tone]}>
          {textBar(percent, cells)}
        </Text>
      )
    }

    const frame = (title: string, summary: string, body: ReturnType<typeof Box>) => (
      <Box
        key="panel"
        flexDirection="column"
        width={PANEL_WIDTH}
        borderStyle="round"
        borderColor={palette.border}
        backgroundColor={palette.surface}
        paddingX={1}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold color={palette.value}>
            {title}
          </Text>
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Text color={palette.label}>{summary}</Text>
            <Button key="panel-close" label="✕" plain role="dismiss" onPress={close} />
          </Box>
        </Box>
        {body}
      </Box>
    )

    const contextPanel = (meter: Meter) => {
      if (slices === null || meter.capacity === undefined || meter.tokens === undefined) return null
      const capacity = meter.capacity
      const shown = slices.used.slice(0, PANEL_ROWS)
      const rest = slices.used.slice(PANEL_ROWS).reduce((total, slice) => total + slice.tokens, 0)
      const rows: Slice[] = rest > 0 ? [...shown, { name: '기타', tokens: rest, color: 'inactive' }] : shown

      return frame(
        '컨텍스트 구성',
        `${formatTokens(meter.tokens)} / ${formatTokens(capacity)}`,
        <Box flexDirection="column">
          {rows.map(slice => (
            <Box key={slice.name} flexDirection="row" alignItems="center" columnGap={1}>
              <Text color={slice.color}>■</Text>
              <Box width={NAME_WIDTH}>
                <Text color={palette.value} wrap="truncate-end">
                  {slice.name}
                </Text>
              </Box>
              <Box flexGrow={1}>{bar(`bar-${slice.name}`, (slice.tokens / capacity) * 100, 'ok', 120, 12)}</Box>
              <Box width={5} justifyContent="flex-end">
                <Text color={palette.label}>{formatTokens(slice.tokens)}</Text>
              </Box>
            </Box>
          ))}
          <Text color={palette.label}>
            남은 공간 {formatTokens(slices.freeTokens)}
            {slices.bufferTokens > 0 ? ` · 자동 compact 예비 ${formatTokens(slices.bufferTokens)}` : ''}
          </Text>
        </Box>,
      )
    }

    const trendPanel = (meter: Meter, reading: Reading) => {
      const projection = reading.projection
      if (projection === undefined || meter.windowMs === undefined || reading.percent === undefined) return null
      const windowMs = meter.windowMs
      const entry = records[meter.id]
      const tone = palette[reading.tone]
      const remaining = reading.remainingMs === undefined ? '' : ` (${formatRemaining(reading.remainingMs, false)} 후)`
      const forecast = describeForecast(projection)

      return frame(
        `${meter.label} 사용 추이`,
        `${Math.round(reading.percent)}%`,
        <Box flexDirection="column">
          {Svg ? (
            <Svg
              key="trend"
              source={trendSvg(entry, projection, windowMs, now, palette, tone)}
              alt={`${meter.label} 사용률 ${Math.round(reading.percent)}%, ${forecast}`}
              width={372}
              height={96}
            />
          ) : (
            <Text color={tone}>{sparkline(entry, projection, now, PANEL_WIDTH - 4)}</Text>
          )}
          <Text color={palette.label}>
            리셋 {formatClock(projection.resetsAt)}
            {remaining}
          </Text>
          <Text color={projection.exhaustsAt !== undefined ? palette.warn : palette.label}>
            {describeRate(projection, windowMs)} · {forecast}
          </Text>
        </Box>,
      )
    }

    const items = readings.map(({ meter, reading }, index) => {
      const label = isShort ? (meter.id === 'context' ? 'ctx' : (WINDOWS[meter.id]?.short ?? meter.label)) : meter.label
      const value = reading.percent === undefined ? '—' : `${Math.round(reading.percent)}%`
      const action = meter.id === 'context' ? '구성' : '추이'
      const isOpen = opened === meter.id

      let detail: { text: string; color: string } | undefined
      if (reading.exhaustsAt !== undefined) {
        detail = { text: `${formatClock(reading.exhaustsAt)}경 소진`, color: palette.warn }
      } else if (reading.remainingMs !== undefined) {
        detail = { text: formatRemaining(reading.remainingMs, isShort), color: palette.label }
      }

      return (
        <Box key={meter.id} flexDirection="row" alignItems="center" columnGap={1}>
          {index > 0 && <Text color={palette.border}>│</Text>}
          <Text color={palette.label}>{label}</Text>
          {!isNarrow && bar(`bar-${meter.id}`, reading.percent, reading.tone, 44, 6)}
          <Text bold color={palette[reading.tone]}>
            {value}
          </Text>
          {detail && <Text color={detail.color}>· {detail.text}</Text>}
          {canOpen(meter, reading) && (
            <Button key={`open-${meter.id}`} label={`${action} ${isOpen ? '▾' : '▴'}`} plain onPress={toggle(meter.id)} />
          )}
        </Box>
      )
    })

    const openReading = readings.find(({ meter }) => meter.id === opened)
    const panel =
      openReading === undefined
        ? null
        : openReading.meter.id === 'context'
          ? contextPanel(openReading.meter)
          : trendPanel(openReading.meter, openReading.reading)

    return (
      <Box flexDirection="column">
        {panel}
        {panel && Svg && <Svg key="panel-gap" source={spacerSvg(PANEL_WIDTH, PANEL_GAP)} alt="패널 간격" width={PANEL_WIDTH} height={PANEL_GAP} />}
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
          {items}
        </Box>
      </Box>
    )
  })
}
