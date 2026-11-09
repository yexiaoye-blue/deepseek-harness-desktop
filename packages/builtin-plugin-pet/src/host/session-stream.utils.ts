import type { PetSessionPayload, PetToolActivity, PetWorkStatus } from '../shared/types'
import type { PetGoalClosing, PetSessionEvent, PetSessionPeer, PetSessionState } from './session-stream.types'

export const PET_REASONING_TAIL_WINDOW = 120
export const PET_REASONING_PUSH_INTERVAL_MS = 500
export const PET_TASK_TEXT_MAX = 40
export function createPetSessionReducer(handle: (action: 'create' | 'update' | 'remove', payload: PetSessionPayload) => void, opts?: {
  now?: () => number
}): PetSessionReducer {
  const now = opts?.now ?? (() => Date.now())
  const states = new Map<string, PetSessionState>()
  const lastSent = new Map<string, PetSessionPayload>()
  const lastReasoningPushAt = new Map<string, number>()
  const applyEvent = (peer: PetSessionPeer, event: PetSessionEvent): void => {
    let state = states.get(peer.id)
    if (state === undefined) {
      state = createPetSessionState(peer.id, peer)
      states.set(peer.id, state)
    }
    state.title = peer.title ?? state.title
    state.displayTitle = peer.displayTitle ?? state.displayTitle
    state.origin = peer.origin ?? state.origin
    state.cwd = peer.cwd ?? state.cwd
    const payload = reduceSessionEvent(state, event)
    if (payload === null)
      return
    if (event.type === 'assistant/chunk' && payload.liveActivity?.kind === 'reasoning') {
      const at = now()
      const last = lastReasoningPushAt.get(peer.id) ?? 0
      if (at - last < PET_REASONING_PUSH_INTERVAL_MS)
        return
      lastReasoningPushAt.set(peer.id, at)
    }
    const previous = lastSent.get(peer.id)
    if (previous && payloadEqual(previous, payload))
      return
    lastSent.set(peer.id, payload)
    handle('update', payload)
  }
  return {
    create(peer: PetSessionPeer): void {
      const state = createPetSessionState(peer.id, peer)
      states.set(peer.id, state)
      const payload = foldPetPayload(state)
      lastSent.set(peer.id, payload)
      handle('create', payload)
    },
    apply: applyEvent,
    chunk(peer: PetSessionPeer, chunk: unknown): void {
      applyEvent(peer, {
        type: 'assistant/chunk',
        seq: 0,
        time: now(),
        data: { chunk },
      })
    },
    idle(id: string): void {
      const state = states.get(id)
      if (state === undefined || !inTurn(state))
        return
      settleIdle(state)
      const payload = foldPetPayload(state)
      const previous = lastSent.get(id)
      if (previous && payloadEqual(previous, payload))
        return
      lastSent.set(id, payload)
      handle('update', payload)
    },
    remove(id: string): void {
      states.delete(id)
      lastSent.delete(id)
      lastReasoningPushAt.delete(id)
      handle('remove', { id })
    },
    clear(): void {
      states.clear()
      lastSent.clear()
      lastReasoningPushAt.clear()
    },
  }
}
export interface PetSessionReducer {
  create: (peer: PetSessionPeer) => void
  apply: (peer: PetSessionPeer, event: PetSessionEvent) => void
  chunk: (peer: PetSessionPeer, chunk: unknown) => void
  idle: (id: string) => void
  remove: (id: string) => void
  clear: () => void
}
function createPetSessionState(id: string, peer: PetSessionPeer): PetSessionState {
  return {
    id,
    origin: peer.origin,
    title: peer.title,
    displayTitle: peer.displayTitle,
    cwd: peer.cwd,
    running: peer.running ?? false,
    turnActive: false,
    stepActive: false,
    openTools: new Map(),
    reasoningTail: '',
    assistantText: '',
  }
}
function foldPetPayload(state: PetSessionState): PetSessionPayload {
  const firstTool = state.openTools.values().next().value
  const liveActivity = state.running && firstTool !== undefined
    ? toolActivity(firstTool.name, firstTool.args)
    : state.running && state.reasoningTail.length > 0
      ? { kind: 'reasoning', text: state.reasoningTail }
      : undefined
  let status: string | undefined
  if (state.lastAgentError)
    status = 'error'
  else if (state.waitingKind)
    status = 'waiting'
  else if (state.running || state.turnActive)
    status = 'running'
  return {
    id: state.id,
    origin: state.origin,
    title: state.title ?? state.displayTitle,
    displayTitle: state.displayTitle,
    message: state.assistantText || undefined,
    status,
    activity: status,
    phase: state.waitingKind,
    running: state.running,
    lastAgentError: state.lastAgentError,
    workStatus: state.workStatus,
    task: state.task,
    toolActivity: state.toolActivity,
    liveActivity,
  }
}
function toolActivityOf(name?: string): PetToolActivity {
  const value = String(name || '').toLowerCase()
  if (/search|grep|find|glob|web|read|fetch|open/.test(value))
    return 'searching'
  if (/write|edit|patch|replace|create|move|delete/.test(value))
    return 'editing'
  if (/test|check|lint|build|verify/.test(value))
    return 'testing'
  if (/shell|bash|exec|command|terminal|powershell|pwsh/.test(value))
    return 'commanding'
  return 'using-tool'
}
function isGoalRoundEvent(data: Record<string, unknown>): boolean {
  const source = data.source as {
    kind?: string
    round?: number
  } | undefined
  return source?.kind === 'goal' && typeof source.round === 'number' && source.round > 0
}
function isReplaceSurfaceEvent(event: PetSessionEvent): boolean {
  const op = event.surfaceOp
  return op !== undefined && op !== 'append' && op.op === 'replace'
}
function goalClosingOf(name: string | undefined, args: string | undefined): PetGoalClosing | undefined {
  if (name !== 'update_goal')
    return undefined
  try {
    const action = (JSON.parse(args ?? '') as {
      action?: string
    }).action
    return action === 'complete' || action === 'blocked' ? action : undefined
  }
  catch {
    return undefined
  }
}
function completedStatus(state: PetSessionState): PetWorkStatus {
  if (!state.goalRound)
    return 'success'
  if (state.goalClosing === 'blocked')
    return 'error'
  return state.goalClosing === 'complete' ? 'success' : 'result'
}
function currentTaskFromTodo(data: Record<string, unknown>): string | undefined {
  const todos = Array.isArray(data.todos)
    ? (data.todos as Array<{
        status?: string
        content?: string
      }>)
    : []
  const current = todos.findLast(todo => todo?.status === 'in_progress')
    ?? todos.find(todo => todo?.status === 'pending')
  const content = Array.from(String(current?.content ?? '').trim())
  if (!content.length)
    return undefined
  return content.length > PET_TASK_TEXT_MAX
    ? `${content.slice(0, PET_TASK_TEXT_MAX).join('')}…`
    : content.join('')
}
const FOLDABLE_EVENTS: ReadonlySet<string> = new Set([
  'turn/start',
  'step/start',
  'assistant/message',
  'tool/call',
  'tool/result',
  'user/message',
  'turn/end',
  'session/title',
  'approval/asked',
  'approval/decided',
])
function reduceSessionEvent(state: PetSessionState, event: PetSessionEvent): PetSessionPayload | null {
  const t = event.type
  const data = event.data ?? {}
  switch (t) {
    case 'turn/start': {
      state.turnActive = true
      state.running = true
      state.reasoningTail = ''
      state.assistantText = ''
      state.waitingKind = undefined
      state.waitingApprovalId = undefined
      state.waitingCallId = undefined
      state.lastAgentError = undefined
      state.workStatus = 'thinking'
      state.task = undefined
      break
    }
    case 'step/start':
    case 'assistant/chunk': {
      state.stepActive = true
      state.running = true
      if (t === 'step/start' && !state.waitingKind && state.openTools.size === 0)
        state.workStatus = 'thinking'
      if (t === 'assistant/chunk') {
        const chunk = data.chunk as {
          type?: string
          text?: string
        } | undefined
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text) {
          state.reasoningTail = (state.reasoningTail + chunk.text).slice(-PET_REASONING_TAIL_WINDOW)
          if (!state.waitingKind && state.openTools.size === 0)
            state.workStatus = 'thinking'
          return foldPetPayload(state)
        }
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text)
          state.assistantText = (state.assistantText + chunk.text).slice(-1000)
        return null
      }
      break
    }
    case 'assistant/message': {
      state.stepActive = true
      state.running = true
      const blocks = (data.message as {
        content?: unknown[]
      } | undefined)?.content as Array<{
        type?: string
        text?: string
      }> | undefined
      const text = blocks?.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
      if (text)
        state.assistantText = text.slice(-1000)
      if (!state.waitingKind && state.openTools.size === 0)
        state.workStatus = 'thinking'
      break
    }
    case 'tool/call': {
      const call = data as {
        callId?: string
        name?: string
        arguments?: string
      }
      const name = call.name
      const closing = goalClosingOf(name, call.arguments)
      if (closing)
        state.goalClosing = closing
      if (name)
        state.openTools.set(call.callId ?? name, { name, args: call.arguments })
      state.running = true
      if (name && isUserQuestionTool(name)) {
        state.waitingKind = 'user-question'
        state.waitingCallId = call.callId ?? name
        state.workStatus = 'waiting'
      }
      else {
        if (name)
          state.toolActivity = toolActivityOf(name)
        state.workStatus = 'working'
      }
      break
    }
    case 'tool/result': {
      const callId = toolCallIdOf(event)
      if (callId) {
        state.openTools.delete(callId)
        if (callId === state.waitingCallId) {
          state.waitingKind = undefined
          state.waitingCallId = undefined
        }
      }
      else {
        state.openTools.clear()
      }
      if (state.openTools.size > 0) {
        state.workStatus = 'working'
        state.toolActivity = toolActivityOf(state.openTools.values().next().value?.name)
      }
      else {
        state.workStatus = state.waitingKind ? 'waiting' : 'result'
      }
      break
    }
    case 'approval/asked': {
      const id = String(data.id ?? '')
      state.waitingKind = 'approval'
      state.waitingApprovalId = id
      state.running = true
      state.workStatus = 'waiting'
      break
    }
    case 'approval/decided': {
      const id = String(data.id ?? '')
      if (!state.waitingApprovalId || id !== state.waitingApprovalId)
        return null
      state.waitingApprovalId = undefined
      state.waitingKind = undefined
      state.workStatus = state.openTools.size > 0 ? 'working' : 'thinking'
      break
    }
    case 'user/message': {
      if (isReplaceSurfaceEvent(event))
        return null
      if (isGoalRoundEvent(data))
        state.goalRound = true
      state.running = true
      state.turnActive = true
      if (state.waitingCallId !== undefined) {
        state.waitingKind = undefined
        state.waitingCallId = undefined
        state.workStatus = state.openTools.size > 0 ? 'working' : 'thinking'
      }
      break
    }
    case 'todo/write': {
      const task = currentTaskFromTodo(data)
      if (task === state.task)
        return null
      state.task = task
      return foldPetPayload(state)
    }
    case 'session/title': {
      const title = data.title
      if (typeof title === 'string' && title) {
        state.title = title
        state.displayTitle = title
      }
      break
    }
    case 'turn/end': {
      state.turnActive = false
      state.stepActive = false
      state.running = false
      state.openTools.clear()
      state.reasoningTail = ''
      state.assistantText = ''
      state.waitingApprovalId = undefined
      state.waitingCallId = undefined
      const reason = (data as {
        reason?: {
          kind?: string
          error?: {
            message?: string
          }
        }
      }).reason
      if (reason?.kind === 'blocked') {
        state.waitingKind = 'blocked'
        state.workStatus = 'waiting'
      }
      else {
        state.waitingKind = undefined
        if (reason?.kind === 'completed') {
          state.workStatus = completedStatus(state)
          state.lastAgentError = undefined
        }
        else if (reason?.kind === 'error' || reason?.kind === 'max-tokens' || reason?.kind === 'timeout') {
          state.workStatus = 'error'
          state.lastAgentError = reason.error?.message ?? reason.kind
        }
        else {
          settleIdle(state)
        }
      }
      state.goalRound = false
      state.goalClosing = undefined
      break
    }
    default:
      break
  }
  if (!FOLDABLE_EVENTS.has(t))
    return null
  return foldPetPayload(state)
}
function settleIdle(state: PetSessionState): void {
  state.turnActive = false
  state.stepActive = false
  state.running = false
  state.openTools.clear()
  state.reasoningTail = ''
  state.assistantText = ''
  state.waitingKind = undefined
  state.waitingApprovalId = undefined
  state.waitingCallId = undefined
  state.workStatus = undefined
  state.lastAgentError = undefined
  state.goalRound = false
  state.goalClosing = undefined
}
function inTurn(state: PetSessionState): boolean {
  return state.running || state.turnActive || state.stepActive
}
function payloadEqual(a: PetSessionPayload, b: PetSessionPayload): boolean {
  return Object.is(a.status, b.status)
    && Object.is(a.activity, b.activity)
    && Object.is(a.phase, b.phase)
    && Object.is(a.running, b.running)
    && Object.is(a.message, b.message)
    && Object.is(a.lastAgentError, b.lastAgentError)
    && Object.is(a.origin, b.origin)
    && Object.is(a.title, b.title)
    && Object.is(a.displayTitle, b.displayTitle)
    && Object.is(a.workStatus, b.workStatus)
    && Object.is(a.task, b.task)
    && Object.is(a.toolActivity, b.toolActivity)
    && Object.is(a.liveActivity?.kind, b.liveActivity?.kind)
    && Object.is(a.liveActivity?.text, b.liveActivity?.text)
    && Object.is(a.liveActivity?.name, b.liveActivity?.name)
    && Object.is(a.liveActivity?.command, b.liveActivity?.command)
    && Object.is(a.liveActivity?.path, b.liveActivity?.path)
    && Object.is(a.liveActivity?.args, b.liveActivity?.args)
}
function toolActivity(name?: string, args?: string): PetSessionPayload['liveActivity'] {
  return name ? { kind: 'tool', name, args } : { kind: 'tool' }
}
function toolCallIdOf(event: PetSessionEvent, fallback = ''): string {
  const data = event.data as Record<string, unknown> | undefined
  const message = data?.message as Record<string, unknown> | undefined
  const content = Array.isArray(message?.content)
    ? (message.content as Array<Record<string, unknown>>).find(item => item.toolCallId)
    : undefined
  const callId = (message?.source as {
    callId?: unknown
  } | undefined)?.callId
  ?? content?.toolCallId
  ?? message?.toolCallId
  ?? message?.callId
  ?? data?.callId
  return String(callId ?? fallback)
}
function isUserQuestionTool(name?: string): boolean {
  const value = String(name || '').toLowerCase()
  const tokens = value.split(/[^a-z0-9]+/u).filter(Boolean)
  if (!tokens.length)
    return false
  const asks = new Set(['ask', 'asking', 'request', 'requests', 'requesting', 'require', 'requires', 'prompt', 'needs', 'need', 'seek', 'seeks', 'get', 'gets'])
  const filler = new Set(['for', 'from', 'the', 'a', 'an'])
  const userWords = new Set(['user', 'human', 'me'])
  const nouns = new Set(['question', 'questions', 'input', 'answer', 'answers', 'decision', 'decisions', 'confirmation', 'approval', 'permission', 'authorization', 'authorisation', 'consent', 'clarify', 'clarification', 'help'])
  const hasUserNoun = tokens.some((token, index) => userWords.has(token) && nouns.has(tokens[index + 1] ?? ''))
  const hasNounFromUser = tokens.some((token, index) => nouns.has(token) && tokens[index + 1] === 'from' && userWords.has(tokens[index + 2] ?? ''))
  const hasAsk = tokens.some((token, index) => {
    if (!asks.has(token))
      return false
    let cursor = index + 1
    while (cursor < tokens.length && (filler.has(tokens[cursor]) || userWords.has(tokens[cursor]))) {
      if (userWords.has(tokens[cursor])) {
        const next = tokens[cursor + 1]
        return !next || nouns.has(next)
      }
      cursor += 1
    }
    return cursor < tokens.length && nouns.has(tokens[cursor])
  })
  const strong = tokens.some(token => token === 'authorize' || token === 'authorise' || token === 'consent')
  const submitsPlanForApproval = tokens.some((token, index) => token === 'exit' && tokens[index + 1] === 'plan' && tokens[index + 2] === 'mode')
  return hasUserNoun || hasNounFromUser || hasAsk || strong || submitsPlanForApproval
}
