import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Job, JobDetail, Pending, Run, Scope } from '../types'
import {
  baseName,
  countBySeverity,
  elapsedOf,
  formatClock,
  formatElapsed,
  isActive,
  kindLabelOf,
  parseCodexConfig,
  parseDetail,
  parseRunFlags,
  parseState,
  PHASE_LABEL,
  resolveRun,
  runLabel,
  SEVERITY_LABEL,
  sortJobs,
  stepOf,
  STEPS,
} from './jobs'
import { PALETTE, stepsSvg } from './theme'
import type { Palette } from './theme'

const jobs = atom({ plugin: 'codex-board', key: 'jobs' } as const, [])
const details = atom({ plugin: 'codex-board', key: 'details' } as const, {})
const pending = atom({ plugin: 'codex-board', key: 'pending' } as const, [])
const expanded = atom({ plugin: 'codex-board', key: 'expanded' } as const, null)
const scope = atom({ plugin: 'codex-board', key: 'scope' } as const, 'mine')
const isDark = atom({ plugin: 'codex-board', key: 'isDark' } as const, true)
const runs = atom({ plugin: 'codex-board', key: 'runs' } as const, {})
const defaults = atom({ plugin: 'codex-board', key: 'defaults' } as const, {})

const PANE = 'codex-board'
const TITLE = 'Codex'
const COMMAND = 'codex-board'
const TICK_MS = 1000
// 진행 중인 작업이 없을 때는 이 틱마다 한 번만 읽는다
const IDLE_TICKS = 10
const MAX_JOBS = 50
const MAX_SHOWN = 8
const MAX_FINDINGS = 12
// 요청 직후 상태 파일에 작업이 생기기까지 기다리는 시간
const PENDING_TTL = 90_000
const CODEX_RUN = /codex-companion\.mjs["']?\s+(review|adversarial-review|task)\b/
const RUN_LABEL: Record<string, string> = { review: '리뷰', 'adversarial-review': '적대적 리뷰', task: '작업' }
const SPINNER = ['◐', '◓', '◑', '◒']
// 로그가 이만큼 멈춰 있으면 마지막 활동 시각을 표시한다
const STALL_MS = 30_000

type Dirs = { configDir: string; tmpDir: string; codexHome: string }
type Context = Dirs & { sessionId: string; root: string; startedAt: number }

// 세션 정보는 재로드 때 session.start에서 다시 채운다
let context: Context = { sessionId: '', root: '', configDir: '', tmpDir: '/tmp', codexHome: '', startedAt: 0 }
let ticks = 0
let isRefreshing = false

async function locateDirs($: EngineInterface): Promise<Dirs> {
  const probe = await $.process
    .run(['sh', '-c', 'printf "%s\\n%s\\n%s" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${TMPDIR:-/tmp}" "${CODEX_HOME:-$HOME/.codex}"'])
    .catch(() => undefined)
  const [configDir = '', tmpDir = '', codexHome = ''] = (probe?.stdout ?? '').split('\n').map(line => line.trim().replace(/\/$/, ''))
  const fromRoot = $.plugin.root.match(/^(.*?)\/(?:plugins\/cache|dev-mods)\//)?.[1]
  return { configDir: configDir || fromRoot || '', tmpDir: tmpDir || '/tmp', codexHome }
}

async function refreshDefaults($: EngineInterface) {
  if (context.codexHome === '') return
  const toml = await $.fs.read(`${context.codexHome}/config.toml`).catch(() => undefined)
  const next = typeof toml === 'string' ? parseCodexConfig(toml) : {}
  if (JSON.stringify(await read($, defaults)) !== JSON.stringify(next)) await update($, defaults, () => next)
}

// 요청마다 그 뒤에 생긴 같은 종류의 작업을 요청 순서대로 하나씩 짝짓고,
// 요청 명령에서 읽은 model·effort를 붙인다. 짝지은 요청의 id를 돌려준다
async function claimRuns($: EngineInterface, list: Job[], waiting: Pending[]): Promise<Set<string>> {
  const known = await read($, runs)
  const claimed: Record<string, Run> = {}
  const matched = new Set<string>()
  for (const one of [...waiting].sort((a, b) => a.at - b.at)) {
    const match = list
      .filter(
        job =>
          // 다른 세션이 같은 레포에서 시작한 작업에는 붙이지 않는다
          (job.sessionId === undefined ? isMine(job) : job.sessionId === context.sessionId) &&
          job.kind === one.kind &&
          known[job.id] === undefined &&
          claimed[job.id] === undefined &&
          Date.parse(job.createdAt) >= one.at - 5_000,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (match === undefined) continue
    claimed[match.id] = one.isAmbiguous === true ? {} : (one.run ?? {})
    matched.add(one.id)
  }
  if (matched.size === 0) return matched
  const ids = new Set(list.map(job => job.id))
  // 동시에 끝난 다른 요청의 짝짓기를 덮어쓰지 않도록 최신 값에 합친다
  const saved = await update($, runs, current => ({
    ...Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))),
    ...claimed,
  }))
  await $.store.set('runs', saved).catch(() => undefined)
  return matched
}

// 첫 Codex 요청 때 생기는 디렉터리도 잡도록 갱신할 때마다 다시 찾는다
async function stateRoots($: EngineInterface): Promise<string[]> {
  const roots: string[] = []
  const dataDir = `${context.configDir}/plugins/data`
  for (const entry of await $.fs.list(dataDir).catch(() => [])) {
    if (entry.kind === 'dir' && entry.name.startsWith('codex')) roots.push(`${dataDir}/${entry.name}/state`)
  }
  roots.push(`${context.tmpDir}/codex-companion`)
  return roots
}

const isMine = (job: Job) => job.sessionId === context.sessionId || job.workspaceRoot === context.root
const inScope = (current: Scope) => (job: Job) => current === 'all' || isMine(job)

async function loadJobs($: EngineInterface): Promise<Job[]> {
  const loaded: Job[] = []
  for (const root of await stateRoots($)) {
    for (const entry of await $.fs.list(root).catch(() => [])) {
      if (entry.kind !== 'dir') continue
      const dir = `${root}/${entry.name}`
      const source = await $.fs.read(`${dir}/state.json`).catch(() => undefined)
      if (typeof source === 'string') loaded.push(...parseState(source, dir))
    }
  }
  const byId = new Map<string, Job>()
  for (const job of loaded) {
    const known = byId.get(job.id)
    if (known === undefined || known.updatedAt < job.updatedAt) byId.set(job.id, job)
  }
  // 다른 레포의 작업이 많아도 이 세션의 작업은 잘리지 않게 한다
  const sorted = sortJobs([...byId.values()])
  const mine = sorted.filter(isMine)
  const others = sorted.filter(job => !isMine(job)).slice(0, Math.max(0, MAX_JOBS - mine.length))
  return sortJobs([...mine, ...others])
}

async function loadDetails($: EngineInterface, list: Job[], current: Record<string, JobDetail>, open: string | null) {
  const next: Record<string, JobDetail> = {}
  for (const job of list) {
    const known = current[job.id]
    const needsLog = isActive(job) || job.id === open
    // 끝난 작업은 결과를 읽을 때까지 다시 시도한다
    const isSettled = isActive(job) || known?.isResultLoaded === true
    if (known !== undefined && known.updatedAt === job.updatedAt && !needsLog && isSettled) {
      next[job.id] = known
      continue
    }
    const jobFile = `${job.stateDir}/jobs/${job.id}.json`
    // 진행 중에도 백그라운드 작업의 요청 값을 읽는다
    const source = await $.fs.read(jobFile).catch(() => undefined)
    const log = await $.fs.read(job.logFile ?? `${job.stateDir}/jobs/${job.id}.log`).catch(() => undefined)
    next[job.id] = parseDetail(typeof source === 'string' ? source : undefined, typeof log === 'string' ? log : undefined, job.updatedAt)
  }
  return next
}

function outcomeOf(job: Job, detail: JobDetail | undefined): string {
  if (job.status === 'failed') return `실패${job.errorMessage ? ` · ${job.errorMessage}` : ''}`
  if (job.status === 'cancelled') return '취소됨'
  const counts = countBySeverity(detail?.findings ?? [])
  const found = counts.map(([severity, count]) => `${SEVERITY_LABEL[severity]} ${count}`).join(' · ')
  if (detail?.verdict === 'approve') return '승인'
  if (found !== '') return `지적 ${found}`
  if (detail?.verdict === 'needs-attention') return '확인 필요'
  return '완료'
}

async function notify($: EngineInterface, before: Job[], after: Job[], loaded: Record<string, JobDetail>) {
  const previous = new Map(before.map(job => [job.id, job]))
  let hasStarted = false
  for (const job of after.filter(isMine)) {
    const old = previous.get(job.id)
    // 이전 세션에서 시작해 아직 도는 작업으로는 패널을 열지 않는다
    // 세션 ID가 없는 작업만 시작 시각으로 판단한다
    const isStartedHere =
      job.sessionId !== undefined ? job.sessionId === context.sessionId : Date.parse(job.createdAt) >= context.startedAt
    if (isActive(job) && isStartedHere && (old === undefined || !isActive(old))) hasStarted = true
    // 두 번의 갱신 사이에 시작하고 끝난 작업도 알린다
    const hasFinishedSinceStart = old === undefined && Date.parse(job.completedAt ?? job.updatedAt) >= context.startedAt
    if (isStartedHere && !isActive(job) && ((old !== undefined && isActive(old)) || hasFinishedSinceStart)) {
      $.ui.toast(`Codex ${kindLabelOf(job)} ${outcomeOf(job, loaded[job.id])}`)
    }
  }
  if (hasStarted) await $.ui.open({ id: PANE, title: TITLE })
}

async function refresh($: EngineInterface) {
  if (isRefreshing || context.sessionId === '') return
  isRefreshing = true
  try {
    const before = await read($, jobs)
    const after = await loadJobs($)
    const open = await read($, expanded)
    const shown = after.filter(isMine).slice(0, MAX_SHOWN)
    const visible = [...shown, ...after.filter(job => !shown.includes(job)).slice(0, MAX_SHOWN)]
    const loaded = await loadDetails($, visible, await read($, details), open)

    if (JSON.stringify(before) !== JSON.stringify(after)) await update($, jobs, () => after)
    if (JSON.stringify(await read($, details)) !== JSON.stringify(loaded)) await update($, details, () => loaded)
    await notify($, before, after, loaded)

    await refreshDefaults($)

    // 상태 파일에 작업이 생겼거나 오래된 요청은 지운다
    const now = await $.clock.now()
    const waiting = await read($, pending)
    const matched = await claimRuns($, after, waiting)
    const kept = waiting.filter(one => now - one.at < PENDING_TTL && !matched.has(one.id))
    if (kept.length !== waiting.length) await update($, pending, () => kept)
  } finally {
    isRefreshing = false
  }
}

async function refreshTheme($: EngineInterface) {
  const rows = await $.config.list().catch(() => [])
  const theme = rows.find(row => row.key === 'theme')?.value
  if (typeof theme === 'string') await update($, isDark, () => !theme.startsWith('light'))
}

// 요청이 끝나면 성공·실패와 상관없이 '요청 중' 행을 지운다
async function track<T>($: EngineInterface, request: Omit<Pending, 'at'>, run: () => Promise<T>): Promise<T> {
  const now = await $.clock.now()
  await update($, pending, list => {
    const others = list.filter(one => one.id !== request.id)
    const runOf = (one: Pick<Pending, 'run'>) => JSON.stringify(one.run ?? {})
    const clashes = (one: Pending) => one.kind === request.kind && runOf(one) !== runOf(request)
    const isAmbiguous = others.some(clashes)
    return [...others.map(one => (clashes(one) ? { ...one, isAmbiguous: true } : one)), { ...request, at: now, ...(isAmbiguous ? { isAmbiguous } : {}) }]
  })
  await $.ui.open({ id: PANE, title: TITLE })
  try {
    return await run()
  } finally {
    // 백그라운드 실행은 작업이 생기기 전에 끝날 수 있어, 짝짓지 못한 요청은 표시만 끄고 남긴다
    const matched = await claimRuns($, await loadJobs($), await read($, pending))
    await update($, pending, list =>
      matched.has(request.id) ? list.filter(one => one.id !== request.id) : list.map(one => (one.id === request.id ? { ...one, isDone: true } : one)),
    )
    await refresh($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Codex 리뷰 대시보드 열기/닫기' })
    context = { sessionId: await $.session.id(), root: await $.session.root(), ...(await locateDirs($)), startedAt: await $.clock.now() }
    const stored = await $.store.get('runs')
    if (stored !== null && typeof stored === 'object') await update($, runs, () => stored as Record<string, Run>)
    await refreshTheme($)
    await refresh($)

    $.clock.every(TICK_MS, async () => {
      ticks += 1
      const isBusy = (await read($, jobs)).some(job => isMine(job) && isActive(job)) || (await read($, pending)).length > 0
      if (isBusy || ticks % IDLE_TICKS === 0) await refresh($)
      // 경과 시간을 초 단위로 갱신한다
      if (isBusy) $.ui.invalidate('ui.render')
    })

    if ((await $.store.get('isPinned')) === true) void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    await refreshTheme($)
    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      await $.store.set('isPinned', false)
      return { text: 'Codex 대시보드를 닫았습니다.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    await $.store.set('isPinned', true)
    return { text: 'Codex 대시보드를 열었습니다. 다음 세션에도 열린 상태로 시작합니다.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('isPinned', false)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const kind = e.command.match(CODEX_RUN)?.[1]
    if (kind === undefined || e.tool_use_id === undefined) return next(e)
    const request = { id: e.tool_use_id, label: `Codex ${RUN_LABEL[kind] ?? kind}`, kind, run: parseRunFlags(e.command) }
    return track($, request, () => next(e))
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.subagent_type !== 'codex:codex-rescue' || e.tool_use_id === undefined) return next(e)
    return track($, { id: e.tool_use_id, label: 'Codex rescue 위임', kind: 'task' }, () => next(e))
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table: ElementTable<RenderSurface> = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const palette = PALETTE[(await read($, isDark)) ? 'dark' : 'light']
    const current = await read($, scope)
    const all = await read($, jobs)
    const loaded = await read($, details)
    const opened = await read($, expanded)
    const waiting = (await read($, pending)).filter(one => one.isDone !== true)
    const requested = await read($, runs)
    const configured = await read($, defaults)
    const now = await $.clock.now()
    const width = e.props.bodyColumns
    const spinner = SPINNER[Math.floor(now / TICK_MS) % SPINNER.length] ?? '◐'

    const list = all.filter(inScope(current))
    const shown = list.slice(0, MAX_SHOWN)
    const running = list.filter(isActive).length
    const done = list.filter(job => job.status === 'completed').length
    const failed = list.filter(job => job.status === 'failed').length

    const toggleScope = () => update($, scope, value => (value === 'mine' ? 'all' : 'mine'))
    const toggleJob = (id: string) => () => update($, expanded, value => (value === id ? null : id))

    const statusOf = (job: Job): { icon: string; label: string; color: string } => {
      if (isActive(job)) return { icon: spinner, label: PHASE_LABEL[job.phase] ?? job.phase, color: palette.active }
      if (job.status === 'failed') return { icon: '✕', label: '실패', color: palette.danger }
      if (job.status === 'cancelled') return { icon: '■', label: '취소됨', color: palette.muted }
      const detail = loaded[job.id]
      const hasIssues = (detail?.findings?.length ?? 0) > 0 || detail?.verdict === 'needs-attention'
      return hasIssues ? { icon: '!', label: '확인 필요', color: palette.warn } : { icon: '✓', label: '완료', color: palette.success }
    }

    const stepper = (job: Job) => {
      const step = stepOf(job)
      if (Svg) {
        const barWidth = Math.max(120, Math.min(260, width * 6))
        return (
          <Box flexDirection="column" rowGap={0}>
            <Svg
              key={`steps-${job.id}`}
              source={stepsSvg(STEPS.length, step, barWidth, palette)}
              alt={`${STEPS.length}단계 중 ${step + 1}단계`}
              width={barWidth}
              height={4}
            />
          </Box>
        )
      }
      return (
        <Box flexDirection="row">
          {STEPS.map((label, index) => (
            <Text key={label} color={index <= step ? palette.active : palette.muted} bold={index === step}>
              {index > 0 ? ' › ' : ''}
              {label}
            </Text>
          ))}
        </Box>
      )
    }

    const findingsOf = (detail: JobDetail) => {
      const findings = detail.findings ?? []
      if (findings.length === 0 || detail.verdict === undefined) {
        return detail.rendered === undefined ? <Text color={palette.label}>결과를 아직 읽지 못했습니다.</Text> : <Markdown text={detail.rendered} />
      }
      const severityColor = { critical: palette.danger, high: palette.danger, medium: palette.warn, low: palette.label }
      return (
        <Box flexDirection="column" rowGap={0}>
          {findings.slice(0, MAX_FINDINGS).map((finding, index) => (
            <Box key={`finding-${index}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text color={severityColor[finding.severity]} bold>
                  {SEVERITY_LABEL[finding.severity]}
                </Text>
                <Text color={palette.value} wrap="wrap">
                  {finding.title}
                </Text>
              </Box>
              {finding.location !== undefined && (
                <Text color={palette.muted} wrap="truncate-start">
                  {'  '}
                  {finding.location}
                </Text>
              )}
            </Box>
          ))}
          {findings.length > MAX_FINDINGS && <Text color={palette.muted}>외 {findings.length - MAX_FINDINGS}건</Text>}
        </Box>
      )
    }

    const card = (job: Job) => {
      const status = statusOf(job)
      const detail = loaded[job.id]
      const elapsed = elapsedOf(job, now)
      const isOpen = opened === job.id
      const lastActivity = Date.parse(detail?.lastActivityAt ?? '')
      const idleMs = isActive(job) && !Number.isNaN(lastActivity) ? now - lastActivity : undefined
      const canOpen = !isActive(job) && detail !== undefined && (detail.rendered !== undefined || (detail.findings?.length ?? 0) > 0)
      const where = job.workspaceRoot === context.root ? '' : `${baseName(job.workspaceRoot)} · `
      const used = resolveRun(job, requested[job.id], detail?.request, configured)
      const usedLabel = used === undefined ? undefined : runLabel(used)

      return (
        <Box
          key={`job-${job.id}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={isActive(job) ? palette.active : palette.border}
          paddingX={1}
        >
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" columnGap={1} flexShrink={1}>
              <Text color={status.color} bold>
                {status.icon}
              </Text>
              <Text color={palette.value} bold wrap="truncate-end">
                {kindLabelOf(job)}
              </Text>
              <Text color={status.color}>{status.label}</Text>
            </Box>
            {elapsed !== undefined && <Text color={palette.label}>{formatElapsed(elapsed)}</Text>}
          </Box>
          {job.summary !== '' && (
            <Text color={palette.label} wrap="truncate-end">
              {job.summary}
            </Text>
          )}
          {isActive(job) && stepper(job)}
          {idleMs !== undefined && idleMs >= STALL_MS && (
            <Text color={palette.warn}>마지막 활동 {formatElapsed(idleMs)} 전</Text>
          )}
          {isActive(job) &&
            (detail?.logTail ?? []).slice(-3).map((line, index) => (
              <Text key={`log-${index}`} color={palette.muted} wrap="truncate-end">
                › {line}
              </Text>
            ))}
          {!isActive(job) && (
            <Text color={status.color} wrap="truncate-end">
              {outcomeOf(job, detail)}
            </Text>
          )}
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Text color={palette.muted} wrap="truncate-end">
              {where}
              {formatClock(job.startedAt ?? job.createdAt)} 시작
              {usedLabel ? ` · ${usedLabel}` : ''}
            </Text>
            {canOpen && <Button key={`open-${job.id}`} label={isOpen ? '접기 ▴' : '결과 ▾'} plain onPress={toggleJob(job.id)} />}
          </Box>
          {isOpen && detail !== undefined && findingsOf(detail)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text color={running > 0 ? palette.active : palette.muted}>진행 {running}</Text>
            <Text color={palette.border}>│</Text>
            <Text color={palette.success}>완료 {done}</Text>
            {failed > 0 && <Text color={palette.border}>│</Text>}
            {failed > 0 && <Text color={palette.danger}>실패 {failed}</Text>}
          </Box>
          <Button key="scope" label={current === 'mine' ? '이 세션 ▾' : '전체 ▾'} plain onPress={toggleScope} />
        </Box>
        {waiting.map(one => (
          <Box key={`pending-${one.id}`} flexDirection="row" columnGap={1} paddingX={1}>
            <Text color={palette.active}>{spinner}</Text>
            <Text color={palette.value}>{one.label}</Text>
            <Text color={palette.label}>요청 중 · {formatElapsed(now - one.at)}</Text>
          </Box>
        ))}
        {shown.length === 0 && waiting.length === 0 && (
          <Box flexDirection="column" paddingX={1}>
            <Text color={palette.label}>{current === 'mine' ? '이 세션의 Codex 작업이 없습니다.' : 'Codex 작업 기록이 없습니다.'}</Text>
            <Text color={palette.muted}>/codex:review, /codex:rescue 로 요청하면 여기에 표시됩니다.</Text>
          </Box>
        )}
        {shown.map(card)}
        {list.length > shown.length && <Text color={palette.muted}>이전 작업 {list.length - shown.length}건은 /codex:status 에서 볼 수 있습니다.</Text>}
      </Box>
    )
  })
}
