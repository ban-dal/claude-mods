export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export type Job = {
  id: string
  kind: string
  title: string
  summary: string
  status: JobStatus
  phase: string
  workspaceRoot: string
  sessionId?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  logFile?: string
  errorMessage?: string
  // 작업이 기록된 codex-companion 상태 디렉터리
  stateDir: string
}

export type Finding = {
  severity: Severity
  title: string
  location?: string
}

export type JobDetail = {
  updatedAt: string
  logTail: string[]
  lastActivityAt?: string
  verdict?: string
  findings?: Finding[]
  rendered?: string
}

// tool.call로 감지했지만 아직 상태 파일에 작업이 생기지 않은 요청
export type Pending = {
  id: string
  label: string
  at: number
}

export type Scope = 'mine' | 'all'

declare module 'claude-code' {
  interface PluginState {
    'codex-board': {
      jobs: Job[]
      details: Record<string, JobDetail>
      pending: Pending[]
      expanded: string | null
      scope: Scope
      isDark: boolean
    }
  }
}
