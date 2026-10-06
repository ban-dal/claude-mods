import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 5시간 구간의 60%가 지난 시점
const NOW = Date.parse('2026-10-02T10:00:00Z')

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

type Node = { type?: string; key?: string; props?: Record<string, unknown>; children?: unknown }

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'children' in node) return textOf((node as Node).children)
  return ''
}

function findAll(node: unknown, match: (node: Node) => boolean): Node[] {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, match))
  if (!node || typeof node !== 'object') return []
  const element = node as Node
  return [...(match(element) ? [element] : []), ...findAll(element.children, match)]
}

const BREAKDOWN = {
  categories: [
    { name: 'Messages', tokens: 148_000, color: 'purple', isDeferred: false, kind: 'used' },
    { name: 'System tools', tokens: 41_000, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 28_000, color: 'cyan', isDeferred: false, kind: 'used' },
    { name: 'Memory files', tokens: 3_000, color: 'warning', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 700_000, color: 'promptBorder', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
  ],
}

const API_USAGE = { input_tokens: 1_000, cache_read_input_tokens: 94_000, cache_creation_input_tokens: 5_000, output_tokens: 800 }

const turn = (agentId?: string) => ({
  answer: '',
  durationMs: 1_000,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'answer' as const,
  ...(agentId === undefined ? {} : { agentId }),
  usage: { ...API_USAGE, model: 'claude-opus-5-5' },
})

const context = (percent: number) => ({ tokens: percent * 10_000, window: 1_000_000, percent })

const measure = (session: number, contextPercent = 44) => ({
  context: context(contextPercent),
  rateLimits: [
    { kind: 'seven_day', percentUsed: 31, resetsAt: '2026-10-05T10:00:00Z' },
    { kind: 'five_hour', percentUsed: session, resetsAt: '2026-10-02T12:00:00Z' },
  ],
  changed: ['context' as const, 'rateLimits' as const],
})

function setup(on: On, options: { hasBreakdown?: boolean; hasApiUsage?: boolean } = {}) {
  const toasts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.usage', () => {
    const value = {
      startedAt: 0,
      context: {
        ...context(44),
        ...(options.hasBreakdown || options.hasApiUsage ? { breakdown: { ...BREAKDOWN, apiUsage: options.hasApiUsage ? API_USAGE : null } } : {}),
      },
      rateLimits: [],
    }
    return { value } as never
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  return Object.assign(toasts, { clock })
}

describe('usage-meter', () => {
  const chips = (drawn: unknown) => findAll(drawn, node => node.type === 'Svg' && node.props?.height === 22)
  const chip = (drawn: unknown, alt: RegExp) => chips(drawn).find(node => alt.test(String(node.props?.alt)))

  test('desktop에서는 컨텍스트, 세션, 주간을 한 줄에 항목색 배경의 칩 SVG로 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    const drawn = await ui.drawn()

    const rows = findAll(drawn, node => node.type === 'Box' && node.props?.flexDirection === 'row' && node.props?.flexWrap === 'wrap')
    expect(rows).toHaveLength(1)
    expect(chips(drawn).map(node => node.props?.alt)).toEqual(['컨텍스트 44%', '세션 40% 2h0m', '주간 31% 3d0h'])
    expect(String(chips(drawn)[0]?.props?.source)).toContain('fill="#a78bfa" fill-opacity="0.16"')
  })

  test('세션 칩은 5시간 중 3시간이 지났으면 막대의 60% 위치에 경과 마커를 그린다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    const drawn = await ui.drawn()
    const session = String(chip(drawn, /^세션/)?.props?.source)
    const bar = session.match(/<rect x="([\d.]+)" y="8" width="36"/)
    const marker = session.match(/<line x1="([\d.]+)" y1="5"/)

    expect(Math.round((Number(marker?.[1]) - Number(bar?.[1])) * 10) / 10).toBe(21.6)
    expect(String(chip(drawn, /^컨텍스트/)?.props?.source)).not.toContain('y1="5"')
  })

  test('5시간 구간 60% 경과에 82% 사용이면 남은 시간 대신 소진 예상 시각을 경고색으로 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(82))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    const session = chip(await ui.drawn(), /^세션/)

    expect(session?.props?.alt).toMatch(/^세션 82% [일월화수목금토] \d{2}:\d{2} 소진$/)
    expect(String(session?.props?.source)).toMatch(/fill="#fbbf24">[일월화수목금토] \d{2}:\d{2} 소진</)
  })

  test('terminal에서는 아이콘 글자와 6칸 텍스트 막대로 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'terminal', ...BAND })
    const text = textOf(await ui.drawn())

    expect(text).toContain('◔▰▰▰▱▱▱44%')
    expect(text).toContain('◷5h▰▰▱▱▱▱40%·2h0m')
    expect(text).toContain('▦7d▰▰▱▱▱▱31%·3d0h')
  })

  test('상세 버튼은 컨텍스트, 캐시, 세션, 주간 순으로 탭을 그리고 첫 탭을 연다', async ($, on) => {
    setup(on, { hasApiUsage: true })
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    await ui.press({ key: 'details' })
    const drawn = await ui.drawn()
    const tabs = findAll(drawn, node => node.type === 'Button' && String(node.key ?? node.props?.key).startsWith('tab-'))

    expect(tabs.map(node => node.props?.label)).toEqual(['컨텍스트', '캐시', '세션', '주간'])
    expect(textOf(drawn)).toContain('컨텍스트 구성')
  })

  test('상세 버튼을 누르면 미터 위에 컨텍스트 구성 패널을 큰 순서로 열고 다시 누르면 닫는다', async ($, on) => {
    setup(on, { hasBreakdown: true })
    await $.session.measure(measure(40))

    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, ...BAND })
      expect(textOf(await ui.drawn())).not.toContain('컨텍스트 구성')

      await ui.press({ key: 'details' })
      const text = textOf(await ui.drawn())
      if (surface === 'terminal') expect(text.indexOf('컨텍스트 구성')).toBeLessThan(text.indexOf('◔'))
      expect(text).toContain('440k / 1M')
      expect(text.indexOf('대화 메시지')).toBeLessThan(text.indexOf('시스템 도구'))
      expect(text).toContain('148k')
      expect(text).toContain('남은 공간 700k · 자동 compact 예비 33k')

      await ui.press({ key: 'details' })
      expect(textOf(await ui.drawn())).not.toContain('컨텍스트 구성')
      await ui.unmount()
    }
  })

  test('패널의 닫기 버튼을 누르면 패널을 닫는다', async ($, on) => {
    setup(on, { hasBreakdown: true })
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    await ui.press({ key: 'details' })
    await ui.press({ key: 'panel-close' })

    expect(textOf(await ui.drawn())).not.toContain('컨텍스트 구성')
  })

  test('컨텍스트 구성을 받지 못하면 컨텍스트 탭 없이 세션 추이를 먼저 연다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    await ui.press({ key: 'details' })

    expect(await ui.find({ key: 'tab-context' })).toBeUndefined()
    expect(textOf(await ui.drawn())).toContain('세션 사용 추이')
  })

  test('패널이 열리면 desktop에서는 미터 줄과의 사이에 8px 간격을 둔다', async ($, on) => {
    setup(on, { hasBreakdown: true })
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    const spacers = async () => findAll(await ui.drawn(), node => node.type === 'Svg' && node.props?.alt === '패널 간격')
    expect(await spacers()).toHaveLength(0)

    await ui.press({ key: 'details' })
    const [gap] = await spacers()
    expect(gap?.props).toMatchObject({ height: 8 })
  })

  test('세션 탭을 누르면 사용 추이 그래프와 리셋 시각, 평균 속도, 예상을 표시한다', async ($, on) => {
    const { clock } = setup(on, { hasBreakdown: true })
    await $.session.measure({ ...measure(20), changed: ['rateLimits'] })
    await clock.advance(30 * 60_000)
    await $.session.measure({ ...measure(40), changed: ['rateLimits'] })

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    await ui.press({ key: 'details' })
    await ui.press({ key: 'tab-five_hour' })
    const drawn = await ui.drawn()
    const text = textOf(drawn)
    const [chart] = findAll(drawn, node => node.type === 'Svg' && node.props?.width === 372)

    expect(text).toContain('세션 사용 추이40%')
    expect(text).toMatch(/리셋 [일월화수목금토] \d{2}:\d{2} \(1시간 30분 후\)/)
    expect(text).toContain('시간당 평균 11%')
    expect(text).toContain('지금 속도면 리셋 시 57% 예상')
    // 기록 2개 + 지금 = 3점, 기록 전 구간 점선
    expect(String(chart?.props?.source).match(/<polyline[^>]*points="([^"]+)"[^>]*stroke-width="2"/)?.[1]?.split(' ')).toHaveLength(3)
    expect(String(chart?.props?.source)).toContain('stroke-dasharray="2 3"')
  })

  test('주간 탭을 누르면 세션 추이 대신 하루 평균 사용률을 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    await ui.press({ key: 'details' })
    await ui.press({ key: 'tab-seven_day' })
    const text = textOf(await ui.drawn())

    expect(text).not.toContain('세션 사용 추이')
    expect(text).toContain('주간 사용 추이31%')
    expect(text).toMatch(/하루 평균 \d/)
  })

  test('terminal에서 세션 추이를 열면 그래프 대신 스파크라인을 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'terminal', ...BAND })
    await ui.press({ key: 'details' })
    const drawn = await ui.drawn()

    expect(findAll(drawn, node => node.type === 'Svg')).toHaveLength(0)
    expect(textOf(drawn)).toMatch(/[▁▂▃▄▅▆▇█]{20,}/)
  })

  test('직전 응답의 캐시 읽기가 입력의 94%면 적중률 94%를 표시하고 턴이 끝나면 1시간 만료까지 남은 시간을 표시한다', async ($, on) => {
    setup(on, { hasApiUsage: true })
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'terminal', ...BAND })
    expect(textOf(await ui.drawn())).toContain('◔▰▰▰▱▱▱44%│↯94%│◷')

    await $.turn.complete(turn())
    expect(textOf(await ui.drawn())).toContain('↯94%·1h0m')
  })

  test('캐시 만료가 5분 안으로 남으면 경고색으로 표시하고 1시간이 지나면 만료를 표시한다', async ($, on) => {
    const { clock } = setup(on, { hasApiUsage: true })
    await $.session.measure(measure(40))
    await $.turn.complete(turn())

    await clock.advance(56 * 60_000)
    const expiring = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    const cache = chip(await expiring.drawn(), /^캐시/)
    expect(cache?.props?.alt).toBe('캐시 적중 94% 4m')
    expect(String(cache?.props?.source)).toContain('fill="#fbbf24">4m<')
    await expiring.unmount()

    await clock.advance(4 * 60_000)
    const expired = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    expect(chip(await expired.drawn(), /^캐시/)?.props?.alt).toBe('캐시 적중 94% 만료')
  })

  test('서브에이전트 턴은 캐시 만료 시각을 갱신하지 않고 누적 토큰에만 더한다', async ($, on) => {
    const { clock } = setup(on, { hasApiUsage: true })
    await $.session.measure(measure(40))
    await $.turn.complete(turn())
    await clock.advance(30 * 60_000)
    await $.turn.complete(turn('agent-1'))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    expect(chip(await ui.drawn(), /^캐시/)?.props?.alt).toBe('캐시 적중 94% 30m')

    await ui.press({ key: 'details' })
    await ui.press({ key: 'tab-cache' })
    expect(textOf(await ui.drawn())).toContain('세션 누적 읽기 188k · 쓰기 10k · 적중 94%')
  })

  test('캐시 탭을 누르면 직전 응답의 읽기, 쓰기, 미캐시 토큰과 만료 시각을 패널로 표시한다', async ($, on) => {
    setup(on, { hasApiUsage: true })
    await $.session.measure(measure(40))
    await $.turn.complete(turn())

    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, ...BAND })
      await ui.press({ key: 'details' })
      await ui.press({ key: 'tab-cache' })
      const text = textOf(await ui.drawn())

      expect(text).toContain('프롬프트 캐시적중 94%')
      expect(text).toContain('직전 응답 입력 100k')
      expect(text).toMatch(/캐시 읽기.*94k/)
      expect(text).toMatch(/캐시 쓰기.*5k/)
      expect(text).toMatch(/미캐시 입력.*1k/)
      expect(text).toMatch(/만료 [일월화수목금토] \d{2}:\d{2} \(1시간 0분 후\) · TTL 1시간/)

      await ui.press({ key: 'details' })
      await ui.unmount()
    }
  })

  test('캐시 기록이 없으면 캐시 칩을 그리지 않는다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })

    expect(chip(await ui.drawn(), /^캐시/)).toBeUndefined()
  })

  test('세션 비용 1.234달러는 미터 줄 끝의 칩에 $1.23으로 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure({ ...measure(40), cost: { usd: 1.234 } })

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })

    expect(chips(await ui.drawn()).at(-1)?.props?.alt).toBe('비용 $1.23')
  })

  test('세션 한도가 81%에서 83%로 오르면 같은 리셋 구간에서 토스트를 한 번만 띄운다', async ($, on) => {
    const toasts = setup(on)
    await $.session.measure(measure(81))
    await $.session.measure(measure(83))

    expect(toasts).toEqual(['세션 한도 81% 사용 · 2시간 0분 후 리셋'])
  })

  test('컨텍스트 92%는 /compact 안내 토스트를 띄우고 compact 후 다시 92%가 되면 또 띄운다', async ($, on) => {
    const toasts = setup(on)
    await $.session.measure(measure(10, 92))
    await $.session.measure(measure(10, 30))
    await $.session.measure(measure(10, 92))

    expect(toasts.filter(text => text.includes('/compact'))).toHaveLength(2)
  })

  test('/usage-meter 명령은 미터를 숨기고 다시 실행하면 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(50))

    const hidden = await $.command.run({ command: 'usage-meter', args: '' } as never)
    expect(hidden.text).toContain('숨겼습니다')

    const shown = await $.command.run({ command: 'usage-meter', args: '' } as never)
    expect(shown.text).toContain('표시합니다')
  })
})
