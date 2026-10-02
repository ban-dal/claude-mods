import type { CodexDefaults, Finding, Job, JobDetail, JobStatus, Run, Severity } from '../types'

const STATUSES: readonly JobStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled']
const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low']
// 네이티브 리뷰는 [P0]~[P3] 태그로 우선순위를 적는다
const PRIORITY: Record<string, Severity> = { '0': 'critical', '1': 'high', '2': 'medium', '3': 'low' }
const LOG_TAIL = 4
const RENDERED_LIMIT = 9000

export const PHASE_LABEL: Record<string, string> = {
  queued: '대기 중',
  starting: '시작 중',
  reviewing: '리뷰 중',
  investigating: '코드 조사 중',
  running: '명령 실행 중',
  verifying: '검증 중',
  editing: '수정 중',
  finalizing: '결과 정리 중',
  done: '완료',
  failed: '실패',
  cancelled: '취소됨',
}

export const STEPS = ['대기', '시작', '분석', '정리', '완료']

const KIND_LABEL: Record<string, string> = {
  review: '리뷰',
  'adversarial-review': '적대적 리뷰',
  task: '작업',
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: '치명',
  high: '높음',
  medium: '보통',
  low: '낮음',
}

export function isActive(job: Job): boolean {
  return job.status === 'queued' || job.status === 'running'
}

export function kindLabelOf(job: Job): string {
  if (job.title === 'Codex Stop Gate Review') return '중단 시점 리뷰'
  return KIND_LABEL[job.kind] ?? job.kind
}

export function stepOf(job: Job): number {
  if (job.status === 'completed') return STEPS.length - 1
  switch (job.phase) {
    case 'queued':
      return 0
    case 'starting':
      return 1
    case 'finalizing':
      return 3
    case 'done':
      return 4
    default:
      return 2
  }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

function toJob(raw: unknown, stateDir: string): Job | null {
  if (!raw || typeof raw !== 'object') return null
  const job = raw as Record<string, unknown>
  const id = text(job.id)
  const status = STATUSES.find(one => one === job.status)
  const workspaceRoot = text(job.workspaceRoot)
  if (id === undefined || status === undefined || workspaceRoot === undefined) return null
  const createdAt = text(job.createdAt) ?? ''

  return {
    id,
    kind: text(job.kind) ?? 'task',
    title: text(job.title) ?? 'Codex',
    summary: text(job.summary) ?? '',
    status,
    phase: text(job.phase) ?? status,
    workspaceRoot,
    sessionId: text(job.sessionId),
    createdAt,
    updatedAt: text(job.updatedAt) ?? createdAt,
    startedAt: text(job.startedAt),
    completedAt: text(job.completedAt),
    logFile: text(job.logFile),
    errorMessage: text(job.errorMessage),
    stateDir,
  }
}

export function parseState(source: string, stateDir: string): Job[] {
  try {
    const state = JSON.parse(source) as { jobs?: unknown }
    if (!Array.isArray(state.jobs)) return []
    return state.jobs.map(raw => toJob(raw, stateDir)).filter((job): job is Job => job !== null)
  } catch {
    return []
  }
}

export function sortJobs(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => {
    if (isActive(a) !== isActive(b)) return isActive(a) ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

export function tailOf(log: string, count = LOG_TAIL): string[] {
  return log
    .split('\n')
    .map(line => line.match(/^\[[^\]]+\]\s+(.*)$/)?.[1]?.trim() ?? '')
    .filter(line => line !== '')
    .slice(-count)
}

function nativeFindings(review: string): Finding[] {
  return review
    .split('\n')
    .map(line => line.match(/\[P([0-3])\]\s*(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(match => {
      const rest = (match[2] ?? '').trim()
      const location = rest.match(/([\w./@-]+\.\w+(?::\d+(?:-\d+)?)?)\s*$/)?.[1]
      const title = location === undefined ? rest : rest.slice(0, rest.length - location.length).replace(/[\s—–-]+$/, '')
      return { severity: PRIORITY[match[1] ?? '3'] ?? 'low', title: title || rest, location }
    })
}

function structuredFindings(value: unknown): Finding[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return []
    const finding = raw as Record<string, unknown>
    const severity = SEVERITIES.find(one => one === finding.severity) ?? 'low'
    const file = text(finding.file)
    const start = typeof finding.line_start === 'number' ? finding.line_start : undefined
    const end = typeof finding.line_end === 'number' && finding.line_end !== start ? `-${finding.line_end}` : ''
    const location = file === undefined ? undefined : start === undefined ? file : `${file}:${start}${end}`
    return [{ severity, title: text(finding.title) ?? '(제목 없음)', location }]
  })
}

export function parseDetail(source: string | undefined, log: string | undefined, updatedAt: string): JobDetail {
  const detail: JobDetail = { updatedAt, logTail: log === undefined ? [] : tailOf(log) }
  const stamps = log?.match(/^\[([^\]]+)\]/gm)
  const last = stamps?.[stamps.length - 1]
  if (last !== undefined) detail.lastActivityAt = last.slice(1, -1)
  if (source === undefined) return detail

  try {
    const stored = JSON.parse(source) as Record<string, unknown>
    const payload = (stored.result ?? {}) as Record<string, unknown>
    const parsed = (payload.result ?? {}) as Record<string, unknown>
    const codex = (payload.codex ?? {}) as Record<string, unknown>

    detail.isResultLoaded = STATUSES.some(status => status === stored.status && status !== 'queued' && status !== 'running')
    detail.verdict = text(parsed.verdict)
    detail.findings = structuredFindings(parsed.findings)
    if (detail.findings === undefined && payload.review === 'Review') {
      detail.findings = nativeFindings(text(codex.stdout) ?? '')
    }
    const request = (stored.request ?? {}) as Record<string, unknown>
    const requested = { model: text(request.model), effort: text(request.effort) }
    if (requested.model !== undefined || requested.effort !== undefined) detail.request = requested
    const rendered = text(stored.rendered)
    if (rendered !== undefined) {
      detail.rendered = rendered.length > RENDERED_LIMIT ? `${rendered.slice(0, RENDERED_LIMIT)}\n\n…(생략)` : rendered
    }
  } catch {
    // 작성 중인 파일은 다음 갱신 때 다시 읽는다
  }
  return detail
}

// codex-companion이 받아들이는 모델 별칭
const MODEL_ALIAS: Record<string, string> = { spark: 'gpt-5.3-codex-spark' }

// 따옴표로 묶인 프롬프트가 한 토큰이 되도록 셸 규칙대로 나눈다
function tokensOf(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  let hasToken = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    if (quote !== null) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < command.length) current += command[++index] ?? ''
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      hasToken = true
    } else if (char === '\\' && index + 1 < command.length) {
      current += command[++index] ?? ''
      hasToken = true
    } else if (/\s/.test(char)) {
      if (hasToken || current !== '') tokens.push(current)
      current = ''
      hasToken = false
    } else {
      current += char
    }
  }
  if (hasToken || current !== '') tokens.push(current)
  return tokens
}

const flagOf = (tokens: string[], names: string[]): string | undefined => {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (names.includes(token)) return tokens[index + 1]
    const name = names.find(one => token.startsWith(`${one}=`))
    if (name !== undefined) return token.slice(name.length + 1)
  }
  return undefined
}

export function parseRunFlags(command: string): Run {
  const tokens = tokensOf(command)
  const start = tokens.findIndex(token => /codex-companion\.mjs$/.test(token))
  const args = start < 0 ? [] : tokens.slice(start + 1)
  const model = flagOf(args, ['--model', '-m'])
  const effort = flagOf(args, ['--effort'])
  return {
    ...(model === undefined ? {} : { model: MODEL_ALIAS[model.toLowerCase()] ?? model }),
    ...(effort === undefined ? {} : { effort: effort.toLowerCase() }),
  }
}

export function parseCodexConfig(toml: string): CodexDefaults {
  const top = toml.split(/^\s*\[/m)[0] ?? ''
  const value = (key: string) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'))?.[1]
  const defaults: CodexDefaults = {}
  const model = value('model')
  const effort = value('model_reasoning_effort')
  const reviewModel = value('review_model')
  if (model !== undefined) defaults.model = model
  if (effort !== undefined) defaults.effort = effort
  if (reviewModel !== undefined) defaults.reviewModel = reviewModel
  return defaults
}

export type ResolvedRun = { model?: string; effort?: string; isDefault: boolean }

// 작업 파일 > 요청 명령 > config.toml 순으로 고른다
export function resolveRun(job: Job, run: Run | undefined, request: Run | undefined, defaults: CodexDefaults): ResolvedRun | undefined {
  const known = { ...run, ...request }
  const fallbackModel = job.kind === 'review' ? (defaults.reviewModel ?? defaults.model) : defaults.model
  const model = known.model ?? fallbackModel
  const effort = known.effort ?? defaults.effort
  if (model === undefined && effort === undefined) return undefined
  return { model, effort, isDefault: known.model === undefined || known.effort === undefined }
}

export function countBySeverity(findings: Finding[]): [Severity, number][] {
  return SEVERITIES.map(severity => [severity, findings.filter(one => one.severity === severity).length] as [Severity, number]).filter(
    ([, count]) => count > 0,
  )
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}초`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분 ${String(seconds % 60).padStart(2, '0')}초`
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
}

export function formatClock(iso: string | undefined): string {
  const time = iso === undefined ? NaN : Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function elapsedOf(job: Job, now: number): number | undefined {
  const start = Date.parse(job.startedAt ?? job.createdAt)
  if (Number.isNaN(start)) return undefined
  const end = isActive(job) ? now : Date.parse(job.completedAt ?? job.updatedAt)
  return Number.isNaN(end) ? undefined : end - start
}

export function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}
