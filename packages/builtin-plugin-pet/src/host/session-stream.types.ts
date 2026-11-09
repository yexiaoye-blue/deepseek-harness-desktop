import type { PetToolActivity, PetWorkStatus } from '../shared/types'

export interface PetSessionEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
  surfaceOp?: 'append' | {
    op?: string
    startSeq?: number
    endSeq?: number
  }
}
export type PetGoalClosing = 'complete' | 'blocked'
export interface PetSessionPeer {
  id: string
  origin?: 'subagent'
  title?: string
  displayTitle?: string
  cwd?: string
  running?: boolean
}
export interface PetSessionState {
  id: string
  origin?: 'subagent'
  title?: string
  displayTitle?: string
  cwd?: string
  running: boolean
  turnActive: boolean
  stepActive: boolean
  openTools: Map<string, {
    name: string
    args?: string
  }>
  reasoningTail: string
  assistantText: string
  lastAgentError?: string
  waitingKind?: 'approval' | 'user-question' | 'blocked'
  waitingApprovalId?: string
  waitingCallId?: string
  workStatus?: PetWorkStatus
  goalRound?: boolean
  goalClosing?: PetGoalClosing
  task?: string
  toolActivity?: PetToolActivity
}
export interface TitleServiceLike {
  get?: (session: unknown) => {
    title?: string
  } | undefined
}
export interface ProjectionRegistryLike {
  stateOf?: (session: unknown, key: string) => unknown
}
