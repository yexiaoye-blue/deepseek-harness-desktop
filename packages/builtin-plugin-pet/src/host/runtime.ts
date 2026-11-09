import type { SessionStreamSink } from '../shared/types'

export const sinks = new Set<SessionStreamSink>()
export const knownSessions = new Set<string>()
let disposeSessionBus: (() => void) | undefined
export function isSessionBusAttached(): boolean {
  return disposeSessionBus !== undefined
}
export function setSessionBusDispose(dispose: (() => void) | undefined): void {
  disposeSessionBus = dispose
}
export function closeSessionBus(): void {
  const dispose = disposeSessionBus
  disposeSessionBus = undefined
  dispose?.()
  knownSessions.clear()
}
export function resetRuntime(): void {
  const open = [...sinks]
  sinks.clear()
  closeSessionBus()
  for (const sink of open)
    sink.close()
}
