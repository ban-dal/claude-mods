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

const context = (percent: number) => ({ tokens: percent * 10_000, window: 1_000_000, percent })

const measure = (session: number, contextPercent = 44) => ({
  context: context(contextPercent),
  rateLimits: [
    { kind: 'seven_day', percentUsed: 31, resetsAt: '2026-10-05T10:00:00Z' },
    { kind: 'five_hour', percentUsed: session, resetsAt: '2026-10-02T12:00:00Z' },
  ],
  changed: ['context' as const, 'rateLimits' as const],
})

function setup(on: On, options: { hasBreakdown?: boolean } = {}) {
  const toasts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.usage', () => {
    const value = {
      startedAt: 0,
      context: { ...context(44), ...(options.hasBreakdown ? { breakdown: BREAKDOWN } : {}) },
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
  test('desktop에서는 컨텍스트, 세션, 주간을 한 줄 Box 안에 막대 SVG와 함께 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    const drawn = await ui.drawn()
    const text = textOf(drawn)

    const rows = findAll(drawn, node => node.type === 'Box' && node.props?.flexDirection === 'row' && node.props?.flexWrap === 'wrap')
    expect(rows).toHaveLength(1)
    expect(findAll(drawn, node => node.type === 'Svg')).toHaveLength(3)
    expect(text).toContain('컨텍스트44%')
    expect(text).toContain('세션40%· 2시간 0분')
    expect(text).toContain('주간31%· 3일')
  })

  test('5시간 구간 60% 경과에 82% 사용이면 남은 시간 대신 소진 예상 시각을 경고색으로 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(82))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    const drawn = await ui.drawn()
    const forecast = findAll(drawn, node => node.type === 'Text' && /경 소진/.test(textOf(node)))

    expect(textOf(forecast[0])).toMatch(/· [일월화수목금토] \d{2}:\d{2}경 소진/)
    expect(forecast[0]?.props?.color).toBe('#fbbf24')
    expect(textOf(drawn)).not.toContain('2시간 0분')
  })

  test('terminal에서는 ctx, 5h, 7d 라벨과 6칸 텍스트 막대를 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'terminal', ...BAND })
    const text = textOf(await ui.drawn())

    expect(text).toContain('ctx▰▰▰▱▱▱44%')
    expect(text).toContain('5h▰▰▱▱▱▱40%· 2h0m')
    expect(text).toContain('7d▰▰▱▱▱▱31%· 3d0h')
  })

  test('구성 버튼을 누르면 미터 위에 컨텍스트 구성 패널을 큰 순서로 열고 다시 누르면 닫는다', async ($, on) => {
    setup(on, { hasBreakdown: true })
    await $.session.measure(measure(40))

    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, ...BAND })
      expect(textOf(await ui.drawn())).not.toContain('컨텍스트 구성')

      await ui.press({ key: 'open-context' })
      const text = textOf(await ui.drawn())
      expect(text.indexOf('컨텍스트 구성')).toBeLessThan(text.indexOf(surface === 'desktop' ? '컨텍스트44%' : 'ctx'))
      expect(text).toContain('440k / 1M')
      expect(text.indexOf('대화 메시지')).toBeLessThan(text.indexOf('시스템 도구'))
      expect(text).toContain('148k')
      expect(text).toContain('남은 공간 700k · 자동 compact 예비 33k')

      await ui.press({ key: 'open-context' })
      expect(textOf(await ui.drawn())).not.toContain('컨텍스트 구성')
      await ui.unmount()
    }
  })

  test('구성 패널의 닫기 버튼을 누르면 패널을 닫는다', async ($, on) => {
    setup(on, { hasBreakdown: true })
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    await ui.press({ key: 'open-context' })
    await ui.press({ key: 'panel-close' })

    expect(textOf(await ui.drawn())).not.toContain('컨텍스트 구성')
  })

  test('컨텍스트 구성을 받지 못하면 구성 버튼을 그리지 않는다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })

    expect(await ui.find({ key: 'open-context' })).toBeUndefined()
  })

  test('구성 패널이 열리면 desktop에서는 미터 줄과의 사이에 8px 간격을 둔다', async ($, on) => {
    setup(on, { hasBreakdown: true })
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    const spacers = async () => findAll(await ui.drawn(), node => node.type === 'Svg' && node.props?.alt === '패널 간격')
    expect(await spacers()).toHaveLength(0)

    await ui.press({ key: 'open-context' })
    const [gap] = await spacers()
    expect(gap?.props).toMatchObject({ height: 8 })
  })

  test('세션 추이 버튼을 누르면 사용 추이 그래프와 리셋 시각, 평균 속도, 예상을 표시한다', async ($, on) => {
    const { clock } = setup(on)
    await $.session.measure({ ...measure(20), changed: ['rateLimits'] })
    await clock.advance(30 * 60_000)
    await $.session.measure({ ...measure(40), changed: ['rateLimits'] })

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    await ui.press({ key: 'open-five_hour' })
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

  test('주간 추이를 열면 세션 패널은 닫히고 하루 평균 사용률을 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    await ui.press({ key: 'open-five_hour' })
    await ui.press({ key: 'open-seven_day' })
    const text = textOf(await ui.drawn())

    expect(text).not.toContain('세션 사용 추이')
    expect(text).toContain('주간 사용 추이31%')
    expect(text).toMatch(/하루 평균 \d/)
  })

  test('terminal에서 세션 추이를 열면 그래프 대신 스파크라인을 표시한다', async ($, on) => {
    setup(on)
    await $.session.measure(measure(40))

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'terminal', ...BAND })
    await ui.press({ key: 'open-five_hour' })
    const drawn = await ui.drawn()

    expect(findAll(drawn, node => node.type === 'Svg')).toHaveLength(0)
    expect(textOf(drawn)).toMatch(/[▁▂▃▄▅▆▇█]{20,}/)
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
