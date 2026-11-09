import type { PetSessionPayload, SessionStreamSink } from '../shared/types'
import type { PetSessionEvent, PetSessionPeer, ProjectionRegistryLike, TitleServiceLike } from './session-stream.types'
import { closeSessionBus, isSessionBusAttached, knownSessions, setSessionBusDispose, sinks } from './runtime'
import { createPetSessionReducer } from './session-stream.utils'

const reducer = createPetSessionReducer(publish)
let titleService: TitleServiceLike | undefined
let projections: ProjectionRegistryLike | undefined
let hostContext: HostLike | undefined
export interface HostLike {
  on: (event: string, handler: (...args: never[]) => void) => (() => void) | void
  get?: (name: string) => unknown
  workspaceRegistry?: {
    archivedSessionIds?: readonly string[]
  }
}
export function attachHost(ctx: HostLike | undefined): void {
  hostContext = ctx
}
export const sessionStream = {
  start(sink: SessionStreamSink): {
    detach: () => void
    stateLost: boolean
  } {
    const stateLost = sinks.size === 0
    sinks.add(sink)
    attachSessionBus()
    return {
      detach: () => {
        sinks.delete(sink)
        if (sinks.size > 0)
          return
        closeSessionBus()
        reducer.clear()
      },
      stateLost,
    }
  },
}
function publish(action: 'create' | 'update' | 'remove', payload: PetSessionPayload): void {
  const frame = JSON.stringify({ action, payload })
  for (const sink of sinks)
    sink.push(frame)
}
function attachSessionBus(): void {
  if (isSessionBusAttached())
    return
  const ctx = hostContext
  if (ctx === undefined)
    return
  titleService = ctx.get?.('sessionTitle') as TitleServiceLike | undefined
  projections = ctx.get?.('sessionProjections') as ProjectionRegistryLike | undefined
  const disposers: Array<() => void> = []
  const bind = (event: string, handler: (...args: never[]) => void): void => {
    const dispose = ctx.on(event, handler)
    if (typeof dispose === 'function')
      disposers.push(dispose)
  }
  bind('session/event', handleSessionEvent as never)
  bind('session/disposed', handleSessionDisposed as never)
  bind('agent/status', handleAgentStatus as never)
  bind('agent/assistant-stream', handleAssistantStream as never)
  bind('workspace/session-stop', ((payload: {
    sessionId?: unknown
  }) => {
    const id = String(payload?.sessionId ?? '')
    if (id)
      removeKnownSession(id)
  }) as never)
  const archiveTimer = setInterval(() => {
    const archived = hostContext?.workspaceRegistry?.archivedSessionIds
    if (!archived)
      return
    for (const id of archived) {
      if (knownSessions.has(id))
        removeKnownSession(id)
    }
  }, 30000)
  archiveTimer.unref?.()
  disposers.push(() => clearInterval(archiveTimer))
  setSessionBusDispose(() => {
    for (const dispose of disposers)
      dispose()
    titleService = undefined
    projections = undefined
  })
}
function sessionIdOf(session: unknown, event: PetSessionEvent): string {
  const s = session as {
    id?: unknown
    sessionId?: unknown
  } | undefined
  if (typeof s?.id === 'string')
    return s.id
  if (typeof s?.sessionId === 'string')
    return s.sessionId
  return String(event.data?.sessionId ?? '')
}
function peerOf(session: unknown, event: PetSessionEvent, foldTitle?: (session: unknown) => string | undefined): PetSessionPeer {
  const s = session as {
    header?: {
      origin?: 'subagent'
      cwd?: string
    }
    summary?: {
      origin?: 'subagent'
      title?: string
      displayTitle?: string
      cwd?: string
      running?: boolean
    }
    title?: string
    displayTitle?: string
    cwd?: string
    running?: boolean
  } | undefined
  const header = s?.header
  const summary = s?.summary
  const foldedTitle = foldTitle?.(session)
  return {
    id: sessionIdOf(session, event),
    origin: summary?.origin ?? header?.origin,
    title: summary?.title ?? s?.title ?? foldedTitle,
    displayTitle: summary?.displayTitle ?? s?.displayTitle ?? foldedTitle,
    cwd: summary?.cwd ?? header?.cwd ?? s?.cwd,
    running: typeof summary?.running === 'boolean' ? summary.running : s?.running,
  }
}
function asPetEvent(event: unknown): PetSessionEvent {
  const e = event as Partial<PetSessionEvent> | undefined
  return {
    type: typeof e?.type === 'string' ? e.type : '',
    seq: typeof e?.seq === 'number' ? e.seq : 0,
    time: typeof e?.time === 'number' ? e.time : 0,
    data: (e?.data ?? {}) as Record<string, unknown>,
    surfaceOp: e?.surfaceOp,
  }
}
function projectedTitleOf(session: unknown): string | undefined {
  if (projections === undefined)
    projections = hostContext?.get?.('sessionProjections') as ProjectionRegistryLike | undefined
  const title = projections?.stateOf?.(session, 'title')
  return typeof title === 'string' && title ? title : undefined
}
function titleOnFirstSight(session: unknown): string | undefined {
  return projectedTitleOf(session) ?? titleService?.get?.(session)?.title
}
function removeKnownSession(id: string): void {
  if (knownSessions.delete(id))
    reducer.remove(id)
}
function removeIfArchived(id: string): boolean {
  const archivedSessionIds: readonly string[] | undefined = hostContext?.workspaceRegistry?.archivedSessionIds
  if (!archivedSessionIds?.includes(id))
    return false
  removeKnownSession(id)
  return true
}
function handleSessionEvent(session: unknown, event: unknown): void {
  const petEvent = asPetEvent(event)
  const id = sessionIdOf(session, petEvent)
  if (!id || removeIfArchived(id))
    return
  const firstSight = !knownSessions.has(id)
  if (firstSight)
    knownSessions.add(id)
  const peer = firstSight
    ? peerOf(session, petEvent, titleOnFirstSight)
    : peerOf(session, petEvent, projectedTitleOf)
  if (firstSight)
    reducer.create(peer)
  reducer.apply(peer, petEvent)
}
function handleSessionDisposed(session: unknown): void {
  const peer = peerOf(session, { type: '', seq: 0, time: 0, data: {} })
  if (!peer.id)
    return
  knownSessions.delete(peer.id)
  reducer.remove(peer.id)
}
function handleAgentStatus(payload: unknown): void {
  const event = payload as {
    status?: unknown
    agent?: {
      session?: {
        id?: unknown
      }
    }
  } | undefined
  const id = event?.agent?.session?.id
  if (typeof id !== 'string' || id.length === 0 || removeIfArchived(id))
    return
  if (event?.status === 'idle')
    reducer.idle(id)
}
const FRAME_EVENT: PetSessionEvent = { type: '', seq: 0, time: 0, data: {} }
function handleAssistantStream(payload: unknown): void {
  const event = payload as {
    agent?: {
      session?: unknown
    }
    frame?: {
      type?: unknown
      chunk?: unknown
    }
  } | undefined
  const session = event?.agent?.session
  const id = sessionIdOf(session, FRAME_EVENT)
  if (!id || removeIfArchived(id))
    return
  const chunk = event?.frame?.chunk
  if (event?.frame?.type !== 'chunk' || chunk === undefined || chunk === null)
    return
  if (!knownSessions.has(id)) {
    knownSessions.add(id)
    reducer.create(peerOf(session, FRAME_EVENT, titleOnFirstSight))
  }
  reducer.chunk({ id }, chunk)
}
