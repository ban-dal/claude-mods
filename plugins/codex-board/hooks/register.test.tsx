import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { parseDetail, parseRunFlags } from './jobs'

const NOW = Date.parse('2026-10-02T10:00:00Z')
const CONFIG = '/home/me/.claude'
const STATE = `${CONFIG}/plugins/data/codex-openai-codex/state`
const APP = `${STATE}/app-1111`
const OTHER = `${STATE}/other-2222`

const PANE = {
  component: 'Pane',
  requestId: 'codex-board',
  props: { title: 'Codex', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const SURFACES = ['terminal', 'desktop'] as const

type Files = Record<string, string>
type Raw = Record<string, unknown>

const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

const job = (patch: Raw): Raw => ({
  id: 'review-1',
  kind: 'review',
  title: 'Codex Review',
  summary: 'Review working tree diff',
  status: 'running',
  phase: 'investigating',
  workspaceRoot: '/repo/app',
  sessionId: 'S1',
  createdAt: iso(-75_000),
  updatedAt: iso(-1_000),
  startedAt: iso(-75_000),
  ...patch,
})

const state = (...jobs: Raw[]) => JSON.stringify({ version: 1, config: {}, jobs })

function setup(on: On, files: Files) {
  const toasts: string[] = []
  const opened: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)

  on('process.run', () => ({ value: { exitCode: 0, stdout: `${CONFIG}\n/tmp/t\n/home/me/.codex`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('session.id', () => ({ value: 'S1' }) as never)
  on('session.root', () => ({ value: '/repo/app' }) as never)
  on('config.list', () => ({ value: [] }) as never)
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text } as never
  })
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue
      const [name = '', ...rest] = path.slice(prefix.length).split('/')
      names.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    if (names.size === 0) throw new Error(`ENOENT ${e.path}`)
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) } as never
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', (_$, e) => {
    opened.splice(opened.indexOf(e.id), 1)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: [...new Set(opened)].map(id => ({ id, title: 'Codex', isPlaced: true })) }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)

  return { toasts, opened, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo/app', surface: null, isInteractive: true })

describe('codex-board', () => {
  for (const surface of SURFACES) {
    test(`${surface}에서 조사 단계의 리뷰는 단계 표시, 경과 시간, 최근 로그 3줄을 표시한다`, async ($, on) => {
      const log = ['Starting Codex Review.', 'Thread ready.', 'Reviewer started: diff', 'Running command: git diff', 'Searching: atom']
        .map((line, index) => `[${iso(index * 1000 - 60_000)}] ${line}`)
        .join('\n')
      setup(on, { [`${APP}/state.json`]: state(job({})), [`${APP}/jobs/review-1.log`]: log })
      await start($)

      const ui = await $.ui.mount({ plugin: 'codex-board', surface, ...PANE })

      expect(await ui.find({ type: 'Text', text: '코드 조사 중' })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: '1분 15초' })).toBeTruthy()
      expect(await ui.findAll({ type: 'Text', text: /^› / })).toHaveLength(3)
      expect(await ui.find({ type: 'Text', text: '› Searching: atom' })).toBeTruthy()
      if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeTruthy()
      else expect(await ui.find({ type: 'Text', text: ' › 분석' })).toBeTruthy()
    })
  }

  test('needs-attention으로 끝난 적대적 리뷰는 "확인 필요"와 심각도별 개수를 표시하고 결과 버튼을 누르면 지적 목록을 펼친다', async ($, on) => {
    const finding = (severity: string, title: string, line: number) => ({
      severity,
      title,
      body: '-',
      file: 'src/a.ts',
      line_start: line,
      line_end: line,
      confidence: 0.9,
      recommendation: '-',
    })
    const stored = {
      status: 'completed',
      result: {
        review: 'Adversarial Review',
        result: { verdict: 'needs-attention', summary: '-', findings: [finding('high', '경합 조건', 12), finding('medium', '누락된 검사', 40), finding('medium', '중복', 41)] },
      },
      rendered: '# Codex Adversarial Review',
    }
    setup(on, {
      [`${APP}/state.json`]: state(job({ id: 'review-2', kind: 'adversarial-review', status: 'completed', phase: 'done', completedAt: iso(-10_000) })),
      [`${APP}/jobs/review-2.json`]: JSON.stringify(stored),
    })
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'desktop', ...PANE })
    expect(await ui.find({ type: 'Text', text: '확인 필요' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: '지적 높음 1 · 보통 2' })).toBeTruthy()

    await ui.press({ key: 'open-review-2' })
    expect(await ui.find({ type: 'Text', text: '경합 조건' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /src\/a\.ts:40/ })).toBeTruthy()
    expect(await ui.find({ key: 'open-review-2', text: '접기 ▴' })).toBeTruthy()
  })

  test('작업이 running에서 completed로 바뀌면 결과 토스트를 한 번 띄운다', async ($, on) => {
    const files: Files = { [`${APP}/state.json`]: state(job({})) }
    const { toasts, clock } = setup(on, files)
    await start($)
    await $.ui.mount({ plugin: 'codex-board', surface: 'terminal', ...PANE })

    files[`${APP}/state.json`] = state(job({ status: 'completed', phase: 'done', updatedAt: iso(500), completedAt: iso(500) }))
    await clock.advance(2_000)
    await clock.advance(2_000)

    expect(toasts).toEqual(['Codex 리뷰 완료'])
  })

  test('이 세션의 새 작업이 running으로 나타나면 대시보드 패널을 연다', async ($, on) => {
    const files: Files = { [`${APP}/state.json`]: state() }
    const { opened, clock } = setup(on, files)
    await start($)
    await $.ui.mount({ plugin: 'codex-board', surface: 'terminal', ...PANE })
    expect(opened).toEqual([])

    files[`${APP}/state.json`] = state(job({}))
    await clock.advance(10_000)

    expect(opened).toContain('codex-board')
  })

  test('같은 레포의 이전 세션에서 시작해 실행 중인 작업으로는 패널을 자동으로 열지 않는다', async ($, on) => {
    const files: Files = { [`${APP}/state.json`]: state(job({ sessionId: 'S0', createdAt: iso(-600_000) })) }
    const { opened, clock } = setup(on, files)
    await start($)
    await clock.advance(10_000)

    expect(opened).toEqual([])
  })

  test('이전 세션에서 시작한 작업이 끝나면 완료 토스트를 띄우지 않는다', async ($, on) => {
    const files: Files = { [`${APP}/state.json`]: state(job({ sessionId: 'S0', createdAt: iso(-600_000) })) }
    const { toasts, clock } = setup(on, files)
    await start($)

    files[`${APP}/state.json`] = state(job({ sessionId: 'S0', createdAt: iso(-600_000), status: 'completed', phase: 'done', updatedAt: iso(500), completedAt: iso(500) }))
    await clock.advance(10_000)

    expect(toasts).toEqual([])
  })

  test('--model, --effort로 요청한 작업은 카드에 그 model과 effort를 표시한다', async ($, on) => {
    const files: Files = { [`${APP}/state.json`]: state(), '/home/me/.codex/config.toml': 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n' }
    setup(on, files)
    on('tool.call', { tool: 'Bash' }, () => {
      files[`${APP}/state.json`] = state(job({ id: 'task-1', kind: 'task', title: 'Codex Task', createdAt: iso(100), startedAt: iso(100) }))
      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    })
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'terminal', ...PANE })

    await $.tool.call({ tool: 'Bash', tool_use_id: 't3', command: 'node codex-companion.mjs task --model spark --effort high "fix"' } as never)

    expect(await ui.find({ type: 'Text', text: /gpt-5\.3-codex-spark · high$/ })).toBeTruthy()
  })

  test('동시에 실행한 리뷰와 작업 요청은 각자 같은 종류의 작업에 model을 붙인다', async ($, on) => {
    const files: Files = { [`${APP}/state.json`]: state() }
    setup(on, files)
    const releases: (() => void)[] = []
    on('tool.call', { tool: 'Bash' }, async () => {
      await new Promise<void>(resolve => releases.push(resolve))
      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    })
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'terminal', ...PANE })

    const review = $.tool.call({ tool: 'Bash', tool_use_id: 'r', command: 'node /p/codex-companion.mjs review --model gpt-6-sol' } as never)
    const task = $.tool.call({ tool: 'Bash', tool_use_id: 't', command: 'node /p/codex-companion.mjs task --model spark "x"' } as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    files[`${APP}/state.json`] = state(
      job({ id: 'task-1', kind: 'task', title: 'Codex Task', summary: 'x', createdAt: iso(100), startedAt: iso(100) }),
      job({ id: 'review-1', createdAt: iso(200), startedAt: iso(200) }),
    )
    releases.forEach(release => release())
    await Promise.all([review, task])

    expect(await ui.find({ type: 'Text', text: /gpt-6-sol/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /gpt-5\.3-codex-spark/ })).toBeTruthy()
  })

  test('요청 값을 모르는 작업은 config.toml의 model과 effort를 "(기본 설정)"과 함께 표시한다', async ($, on) => {
    setup(on, {
      [`${APP}/state.json`]: state(job({})),
      '/home/me/.codex/config.toml': 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n\n[plugins."x"]\nmodel = "other"\n',
    })
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'desktop', ...PANE })

    expect(await ui.find({ type: 'Text', text: /gpt-6\.1-sol · medium \(기본 설정\)$/ })).toBeTruthy()
  })

  test('같은 레포에서 다른 세션이 새로 시작한 작업으로는 패널을 열거나 토스트를 띄우지 않는다', async ($, on) => {
    const files: Files = { [`${APP}/state.json`]: state() }
    const { opened, toasts, clock } = setup(on, files)
    await start($)

    files[`${APP}/state.json`] = state(job({ sessionId: 'S2', createdAt: iso(1_000), startedAt: iso(1_000) }))
    await clock.advance(10_000)
    files[`${APP}/state.json`] = state(job({ sessionId: 'S2', createdAt: iso(1_000), status: 'completed', phase: 'done', updatedAt: iso(12_000), completedAt: iso(12_000) }))
    await clock.advance(10_000)

    expect(opened).toEqual([])
    expect(toasts).toEqual([])
  })

  test('끝난 작업의 결과 파일을 처음에 못 읽으면 다음 갱신 때 다시 읽어 판정을 표시한다', async ($, on) => {
    const files: Files = { [`${APP}/state.json`]: state(job({ id: 'review-4', kind: 'adversarial-review', status: 'completed', phase: 'done' })) }
    const { clock } = setup(on, files)
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: '승인' })).toBeFalsy()

    files[`${APP}/jobs/review-4.json`] = JSON.stringify({ status: 'completed', result: { result: { verdict: 'approve', summary: '-', findings: [] } } })
    await clock.advance(10_000)

    expect(await ui.find({ type: 'Text', text: '승인' })).toBeTruthy()
  })

  test('범위가 "이 세션"이면 다른 세션·레포의 작업을 숨기고 "전체"로 바꾸면 표시한다', async ($, on) => {
    setup(on, {
      [`${APP}/state.json`]: state(job({ status: 'completed', phase: 'done' })),
      [`${OTHER}/state.json`]: state(job({ id: 'task-9', kind: 'task', title: 'Codex Task', workspaceRoot: '/repo/other', sessionId: 'S2', status: 'failed', phase: 'failed', errorMessage: 'timeout' })),
    })
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'desktop', ...PANE })
    expect(await ui.find({ type: 'Text', text: '실패 · timeout' })).toBeFalsy()

    await ui.press({ key: 'scope' })
    expect(await ui.find({ type: 'Text', text: '실패 · timeout' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^other · / })).toBeTruthy()
  })

  test('Bash로 codex-companion review를 실행하는 동안 "요청 중" 행을 표시하고 끝나면 지운다', async ($, on) => {
    setup(on, { [`${APP}/state.json`]: state() })
    let release = () => {}
    on('tool.call', { tool: 'Bash' }, async () => {
      await new Promise<void>(resolve => (release = resolve))
      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    })
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'terminal', ...PANE })

    const call = $.tool.call({ tool: 'Bash', tool_use_id: 't1', command: 'node "/p/scripts/codex-companion.mjs" review ""' } as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await ui.find({ type: 'Text', text: 'Codex 리뷰' })).toBeTruthy()

    release()
    await call
    expect(await ui.find({ type: 'Text', text: /요청 중/ })).toBeFalsy()
  })

  test('codex-companion을 실행하는 Bash 호출이 예외로 끝나도 "요청 중" 행을 지운다', async ($, on) => {
    setup(on, { [`${APP}/state.json`]: state() })
    on('tool.call', { tool: 'Bash' }, () => {
      throw new Error('boom')
    })
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'terminal', ...PANE })

    await $.tool.call({ tool: 'Bash', tool_use_id: 't2', command: 'node codex-companion.mjs task "x"' } as never).catch(() => undefined)
    expect(await ui.find({ type: 'Text', text: /요청 중/ })).toBeFalsy()
  })

  test('지적 없이 needs-attention으로 끝난 리뷰는 결과 문구와 토스트를 "확인 필요"로 표시한다', async ($, on) => {
    const stored = { status: 'completed', result: { review: 'Adversarial Review', result: { verdict: 'needs-attention', summary: '-', findings: [] } } }
    const files: Files = {
      [`${APP}/state.json`]: state(job({ id: 'review-3', kind: 'adversarial-review' })),
      [`${APP}/jobs/review-3.json`]: JSON.stringify(stored),
    }
    const { toasts, clock } = setup(on, files)
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'desktop', ...PANE })

    files[`${APP}/state.json`] = state(job({ id: 'review-3', kind: 'adversarial-review', status: 'completed', phase: 'done', updatedAt: iso(500) }))
    await clock.advance(2_000)

    expect(toasts).toEqual(['Codex 적대적 리뷰 확인 필요'])
    expect(await ui.findAll({ type: 'Text', text: '확인 필요' })).toHaveLength(2)
  })

  test('두 번의 갱신 사이에 시작하고 끝난 작업도 완료 토스트를 띄운다', async ($, on) => {
    const files: Files = { [`${APP}/state.json`]: state() }
    const { toasts, clock } = setup(on, files)
    await start($)
    await $.ui.mount({ plugin: 'codex-board', surface: 'terminal', ...PANE })

    files[`${APP}/state.json`] = state(job({ status: 'completed', phase: 'done', updatedAt: iso(3_000), completedAt: iso(3_000) }))
    await clock.advance(10_000)

    expect(toasts).toEqual(['Codex 리뷰 완료'])
  })

  test('세션 시작 뒤에 생긴 Codex 상태 디렉터리의 작업도 표시한다', async ($, on) => {
    const files: Files = {}
    const { clock } = setup(on, files)
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'terminal', ...PANE })

    files[`${APP}/state.json`] = state(job({}))
    await clock.advance(10_000)

    expect(await ui.find({ type: 'Text', text: '코드 조사 중' })).toBeTruthy()
  })

  test('다른 레포 작업이 50개를 넘어도 이 세션의 작업은 목록에 남는다', async ($, on) => {
    const others = Array.from({ length: 60 }, (_, index) =>
      job({ id: `task-${index}`, workspaceRoot: '/repo/other', sessionId: 'S2', status: 'completed', phase: 'done', updatedAt: iso(index * 1000) }),
    )
    setup(on, {
      [`${OTHER}/state.json`]: state(...others),
      [`${APP}/state.json`]: state(job({ status: 'completed', phase: 'done', updatedAt: iso(-3_600_000) })),
    })
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'terminal', ...PANE })

    expect(await ui.find({ type: 'Text', text: 'Review working tree diff' })).toBeTruthy()
  })

  test('진행 중인 작업의 로그가 30초 넘게 멈추면 마지막 활동 시각을 경고색으로 표시한다', async ($, on) => {
    setup(on, {
      [`${APP}/state.json`]: state(job({})),
      [`${APP}/jobs/review-1.log`]: `[${iso(-45_000)}] Running command: rg x`,
    })
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'terminal', ...PANE })

    const stalled = await ui.find({ type: 'Text', text: '마지막 활동 45초 전' })
    expect(stalled?.props?.color).toBe('#fbbf24')
  })

  test('작업이 없으면 요청 방법 안내를 표시한다', async ($, on) => {
    setup(on, {})
    await start($)
    const ui = await $.ui.mount({ plugin: 'codex-board', surface: 'desktop', ...PANE })
    expect(await ui.find({ type: 'Text', text: '이 세션의 Codex 작업이 없습니다.' })).toBeTruthy()
  })

  test('/codex-board는 패널을 열고 다시 실행하면 닫는다', async ($, on) => {
    const { opened } = setup(on, {})
    await start($)
    const first = await $.command.run({ command: 'codex-board', args: '' } as never)
    expect(opened).toEqual(['codex-board'])
    expect(JSON.stringify(first)).toContain('열었습니다')

    const second = await $.command.run({ command: 'codex-board', args: '' } as never)
    expect(opened).toEqual([])
    expect(JSON.stringify(second)).toContain('닫았습니다')
  })
})

describe('parseRunFlags', () => {
  test('따옴표 안 프롬프트의 "--model spark"는 옵션으로 읽지 않는다', () => {
    expect(parseRunFlags('node "/p/codex-companion.mjs" task "fix the --model spark option"')).toEqual({})
  })

  test('--model=spark, --effort high는 gpt-5.3-codex-spark와 high를 반환한다', () => {
    expect(parseRunFlags("node /p/codex-companion.mjs task --model=spark --effort high 'x'")).toEqual({ model: 'gpt-5.3-codex-spark', effort: 'high' })
  })
})

describe('parseDetail', () => {
  test('네이티브 리뷰의 [P1], [P2] 줄은 높음·보통 지적과 파일 위치로 바뀐다', () => {
    const stored = JSON.stringify({
      result: { review: 'Review', codex: { stdout: '- [P1] 토큰이 만료돼도 재사용됨 — src/auth.ts:10-14\n- [P2] 빈 배열 처리 누락 src/list.ts:3\n본문' } },
      rendered: '# Codex Review',
    })
    const detail = parseDetail(stored, undefined, 'u')
    expect(detail.findings).toEqual([
      { severity: 'high', title: '토큰이 만료돼도 재사용됨', location: 'src/auth.ts:10-14' },
      { severity: 'medium', title: '빈 배열 처리 누락', location: 'src/list.ts:3' },
    ])
  })
})
