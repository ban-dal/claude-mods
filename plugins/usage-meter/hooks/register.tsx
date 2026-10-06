import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, ModelUsage, Register, RenderSurface, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Breakdown, CacheTokens, Meter, Slice, Snapshot } from '../types'
import { ACCENT, barSvg, CHIP_HEIGHT, chipSvg, formatClock, formatRemaining, formatTokens, ICON_GLYPH, PALETTE, spacerSvg, textBar, toneOf } from './format'
import type { ChipPart, Tone } from './format'
import { describeForecast, describeRate, isHistory, projectionOf, recordSamples, sparkline, trendSvg } from './trend'
import type { Projection } from './trend'

const snapshot = atom({ plugin: 'usage-meter', key: 'snapshot' } as const, null)
const breakdown = atom({ plugin: 'usage-meter', key: 'breakdown' } as const, null)
const history = atom({ plugin: 'usage-meter', key: 'history' } as const, {})
const isDark = atom({ plugin: 'usage-meter', key: 'isDark' } as const, true)
const isHidden = atom({ plugin: 'usage-meter', key: 'isHidden' } as const, false)
const openPanel = atom({ plugin: 'usage-meter', key: 'openPanel' } as const, null)
const alerted = atom({ plugin: 'usage-meter', key: 'alerted' } as const, [])
const cache = atom({ plugin: 'usage-meter', key: 'cache' } as const, { last: null, total: { input: 0, read: 0, write: 0 } })

const COMMAND = 'usage-meter'
const HOUR = 3_600_000

const WINDOWS: Record<string, { label: string; short: string; windowMs: number }> = {
  five_hour: { label: '세션', short: '5h', windowMs: 5 * HOUR },
  seven_day: { label: '주간', short: '7d', windowMs: 7 * 24 * HOUR },
}
const ORDER = ['context', 'five_hour', 'seven_day']
const TAB_LABEL: Record<string, string> = { context: '컨텍스트', cache: '캐시', five_hour: '세션', seven_day: '주간' }
// 칩 배경: 항목색을 이 불투명도로 깐다
const CHIP_TINT = { dark: 0.16, light: 0.12 }
// 프롬프트 캐시 TTL (설정값 1h 고정)
const CACHE_TTL = HOUR
// 만료가 이만큼 남으면 경고색으로 표시한다
const CACHE_WARN_MS = 5 * 60_000

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

function toSnapshot(context: SessionContextUsage, limits: SessionRateLimit[], costUsd: number | undefined): Snapshot {
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
  return { meters: meters.sort((a, b) => rank(a.id) - rank(b.id)), costUsd }
}

function toCacheTokens(usage: ModelUsage): CacheTokens {
  return { input: usage.input_tokens, read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens }
}

function hitRateOf(tokens: CacheTokens): number | undefined {
  const sum = tokens.input + tokens.read + tokens.write
  return sum === 0 ? undefined : (tokens.read / sum) * 100
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

async function refreshDetail($: EngineInterface, context: SessionContextUsage) {
  await update($, breakdown, () => toBreakdown(context))
  const apiUsage = context.breakdown?.apiUsage
  if (apiUsage !== undefined) await update($, cache, current => ({ ...current, last: apiUsage === null ? null : toCacheTokens(apiUsage) }))
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
    await update($, snapshot, () => toSnapshot(usage.context, usage.rateLimits, usage.cost?.usd))
    await refreshDetail($, usage.context)
    await recordHistory($, usage.rateLimits)

    // 리셋까지 남은 시간, 소진 예상, 캐시 만료 표시를 갱신한다
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

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = e.usage
    if (usage === undefined) return result
    const now = await $.clock.now()
    const tokens = toCacheTokens(usage)
    await update($, cache, current => ({
      ...current,
      total: { input: current.total.input + tokens.input, read: current.total.read + tokens.read, write: current.total.write + tokens.write },
      // 서브에이전트 응답은 메인 스레드 캐시를 갱신하지 않는다
      respondedAt: e.agentId === undefined ? now : current.respondedAt,
    }))
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, snapshot, () => toSnapshot(e.context, e.rateLimits, e.cost?.usd))
    if (e.changed.includes('context')) {
      const detailed = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
      if (detailed) await refreshDetail($, detailed.context)
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
    const theme = (await read($, isDark)) ? 'dark' : 'light'
    const palette = PALETTE[theme]
    const accent = ACCENT[theme]
    const slices = await read($, breakdown)
    const records = await read($, history)
    const opened = await read($, openPanel)
    const cached = await read($, cache)
    const now = await $.clock.now()
    const isNarrow = e.props.bodyColumns < 90

    const close = () => update($, openPanel, () => null)

    const readings = current.meters.map(meter => ({ meter, reading: readingOf(meter, now) }))
    const canOpen = (meter: Meter, reading: Reading) =>
      meter.id === 'context' ? slices !== null && meter.capacity !== undefined && meter.tokens !== undefined : reading.projection !== undefined
    // 컨텍스트, 캐시, 한도 순으로 열 수 있는 패널
    const tabs = [
      ...readings.filter(({ meter, reading }) => meter.id === 'context' && canOpen(meter, reading)).map(({ meter }) => meter.id),
      ...(cached.last === null ? [] : ['cache']),
      ...readings.filter(({ meter, reading }) => meter.id !== 'context' && canOpen(meter, reading)).map(({ meter }) => meter.id),
    ]

    const bar = (key: string, percent: number | undefined, color: string, width: number, cells: number) => {
      if (percent === undefined) return null
      if (Svg) {
        return <Svg key={key} source={barSvg(percent, width, color, palette.track)} alt={`${Math.round(percent)}%`} width={width} height={6} />
      }
      return (
        <Text key={key} color={color}>
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
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            {tabs.map(id => (
              <Button
                key={`tab-${id}`}
                label={TAB_LABEL[id] ?? id}
                plain
                dimColor={opened !== id ? true : undefined}
                onPress={() => update($, openPanel, () => id)}
              />
            ))}
          </Box>
          <Button key="panel-close" label="✕" plain role="dismiss" onPress={close} />
        </Box>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold color={palette.value}>
            {title}
          </Text>
          <Text color={palette.label}>{summary}</Text>
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
              <Box flexGrow={1}>{bar(`bar-${slice.name}`, (slice.tokens / capacity) * 100, palette.ok, 120, 12)}</Box>
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

    const cacheExpiresAt = cached.respondedAt === undefined ? undefined : cached.respondedAt + CACHE_TTL
    const cacheRemainingMs = cacheExpiresAt === undefined ? undefined : cacheExpiresAt - now
    const isCacheExpiring = cacheRemainingMs !== undefined && cacheRemainingMs > 0 && cacheRemainingMs < CACHE_WARN_MS

    const cachePanel = () => {
      const last = cached.last
      if (last === null) return null
      const sum = last.input + last.read + last.write
      const rows = [
        { name: '캐시 읽기', tokens: last.read, color: accent.cache ?? palette.ok },
        { name: '캐시 쓰기', tokens: last.write, color: palette.warn },
        { name: '미캐시 입력', tokens: last.input, color: palette.idle },
      ]
      const totalRate = hitRateOf(cached.total)
      const hitRate = hitRateOf(last)

      return frame(
        '프롬프트 캐시',
        hitRate === undefined ? '' : `적중 ${Math.round(hitRate)}%`,
        <Box flexDirection="column">
          <Text color={palette.label}>직전 응답 입력 {formatTokens(sum)}</Text>
          {rows.map(row => (
            <Box key={row.name} flexDirection="row" alignItems="center" columnGap={1}>
              <Text color={row.color}>■</Text>
              <Box width={NAME_WIDTH}>
                <Text color={palette.value}>{row.name}</Text>
              </Box>
              <Box flexGrow={1}>{bar(`bar-${row.name}`, sum === 0 ? 0 : (row.tokens / sum) * 100, row.color, 120, 12)}</Box>
              <Box width={5} justifyContent="flex-end">
                <Text color={palette.label}>{formatTokens(row.tokens)}</Text>
              </Box>
            </Box>
          ))}
          {totalRate !== undefined && (
            <Text color={palette.label}>
              세션 누적 읽기 {formatTokens(cached.total.read)} · 쓰기 {formatTokens(cached.total.write)} · 적중 {Math.round(totalRate)}%
            </Text>
          )}
          <Text color={isCacheExpiring ? palette.warn : palette.label}>
            {cacheExpiresAt === undefined || cacheRemainingMs === undefined
              ? 'TTL 1시간'
              : cacheRemainingMs <= 0
                ? '만료됨 · 다음 요청에서 다시 캐시'
                : `만료 ${formatClock(cacheExpiresAt)} (${formatRemaining(cacheRemainingMs, false)} 후) · TTL 1시간`}
          </Text>
        </Box>,
      )
    }

    // 막대는 항목 고유색, 경고·위험이면 그 색. 숫자는 기본 글자색, 경고·위험이면 그 색
    const barColor = (id: string, tone: Tone) => (tone === 'ok' ? (accent[id] ?? palette.ok) : palette[tone])
    const valueColor = (tone: Tone) => (tone === 'ok' ? palette.value : palette[tone])
    const iconPart = (id: string): ChipPart => ({ kind: 'icon', id, color: accent[id] ?? palette.label })
    const textPart = (text: string, color: string, isBold?: boolean): ChipPart => ({ kind: 'text', text, color, isBold })

    type Item = { id: string; alt: string; parts: ChipPart[] }

    const meterItem = ({ meter, reading }: { meter: Meter; reading: Reading }): Item => {
      const value = reading.percent === undefined ? '—' : `${Math.round(reading.percent)}%`
      const short = WINDOWS[meter.id]?.short
      // 경과 비율 마커: 막대가 이걸 앞서면 시간보다 빨리 쓰는 중
      const marker =
        meter.windowMs === undefined || reading.remainingMs === undefined ? undefined : 1 - reading.remainingMs / meter.windowMs

      let detail: { text: string; color: string } | undefined
      if (reading.exhaustsAt !== undefined) {
        detail = { text: `${formatClock(reading.exhaustsAt)} 소진`, color: palette.warn }
      } else if (reading.remainingMs !== undefined) {
        detail = { text: formatRemaining(reading.remainingMs, true), color: palette.label }
      }

      const parts: ChipPart[] = [iconPart(meter.id)]
      if (short) parts.push(textPart(short, palette.label))
      if (!isNarrow && reading.percent !== undefined) parts.push({ kind: 'bar', percent: reading.percent, color: barColor(meter.id, reading.tone), marker })
      parts.push(textPart(value, valueColor(reading.tone), true))
      if (detail) parts.push({ kind: 'divider' }, iconPart('history'), textPart(detail.text, detail.color))
      return { id: meter.id, alt: [meter.label, value, detail?.text].filter(Boolean).join(' '), parts }
    }

    const cacheItem = (): Item | null => {
      if (cached.last === null && cached.respondedAt === undefined) return null
      const hitRate = cached.last === null ? undefined : hitRateOf(cached.last)
      const value = hitRate === undefined ? '—' : `${Math.round(hitRate)}%`
      const expiry = cacheRemainingMs === undefined ? undefined : cacheRemainingMs <= 0 ? '만료' : formatRemaining(cacheRemainingMs, true)
      const parts: ChipPart[] = [iconPart('cache'), textPart(value, valueColor(hitRate === undefined ? 'idle' : 'ok'), true)]
      if (expiry) parts.push({ kind: 'divider' }, iconPart('hourglass'), textPart(expiry, isCacheExpiring ? palette.warn : palette.label))
      return { id: 'cache', alt: ['캐시 적중', value, expiry].filter(Boolean).join(' '), parts }
    }

    const costItem = (): Item | null => {
      if (current.costUsd === undefined) return null
      const value = `$${current.costUsd.toFixed(2)}`
      return { id: 'cost', alt: `비용 ${value}`, parts: [iconPart('cost'), textPart(value, palette.value, true)] }
    }

    const chipStyle = (id: string) => ({
      tint: accent[id] ?? palette.idle,
      tintOpacity: CHIP_TINT[theme],
      divider: palette.border,
      ink: palette.value,
    })

    // terminal: 칩 배경 없이 글자로. 글자가 없는 아이콘(history, hourglass)은 구분점으로 대신한다
    const textParts = (parts: ChipPart[]) =>
      parts.flatMap((part, index) => {
        const key = `part-${index}`
        if (part.kind === 'icon') {
          const glyph = ICON_GLYPH[part.id]
          return glyph === undefined ? [] : [<Text key={key} color={part.color}>{glyph}</Text>]
        }
        if (part.kind === 'text') {
          return [<Text key={key} bold={part.isBold ? true : undefined} color={part.color}>{part.text}</Text>]
        }
        if (part.kind === 'bar') return [<Text key={key} color={part.color}>{textBar(part.percent, 6)}</Text>]
        return [<Text key={key} color={palette.border}>·</Text>]
      })

    // 컨텍스트는 항상 첫 미터: 캐시를 그 옆에 둔다
    const [contextItem, ...limitItems] = readings.map(meterItem)
    const items = [contextItem, cacheItem(), ...limitItems, costItem()]
      .filter(item => item !== null && item !== undefined)
      .map((item, index) => {
        if (Svg) {
          const chip = chipSvg(item.parts, chipStyle(item.id))
          return <Svg key={item.id} source={chip.source} alt={item.alt} width={chip.width} height={CHIP_HEIGHT} />
        }
        return (
          <Box key={item.id} flexDirection="row" alignItems="center" columnGap={1}>
            {index > 0 && <Text color={palette.border}>│</Text>}
            {textParts(item.parts)}
          </Box>
        )
      })

    const toggleDetails = () => update($, openPanel, value => (value === null ? (tabs[0] ?? null) : null))

    const openReading = readings.find(({ meter }) => meter.id === opened)
    const panel =
      opened === 'cache'
        ? cachePanel()
        : openReading === undefined
          ? null
          : openReading.meter.id === 'context'
            ? contextPanel(openReading.meter)
            : trendPanel(openReading.meter, openReading.reading)

    return (
      <Box flexDirection="column">
        {panel}
        {panel && Svg && <Svg key="panel-gap" source={spacerSvg(PANEL_WIDTH, PANEL_GAP)} alt="패널 간격" width={PANEL_WIDTH} height={PANEL_GAP} />}
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} flexGrow={1} flexShrink={1}>
            {items}
          </Box>
          {tabs.length > 0 && <Button key="details" label="상세" onPress={toggleDetails} />}
        </Box>
      </Box>
    )
  })
}
