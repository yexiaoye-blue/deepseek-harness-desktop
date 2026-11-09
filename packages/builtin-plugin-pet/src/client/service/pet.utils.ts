import type { ClientAdapter } from '../sdk'

interface WorkspaceItem {
  id?: string
  sessionIds?: readonly string[]
  workspaceId?: string
}
interface SessionsSnapshot {
  current?: string
  ids?: readonly string[]
}
interface WorkspacesSnapshot {
  items?: WorkspaceItem[]
  recentWorkspaceId?: string
}
export function chooseWorkspace(adapter: ClientAdapter): string | undefined {
  const sessions = (adapter.sessions.list?.getSnapshot() ?? {}) as SessionsSnapshot
  const workspaces = (adapter.workspaces.list?.getSnapshot() ?? {}) as WorkspacesSnapshot
  const items = workspaces.items ?? []
  const current = sessions.current
  const currentItem = current === undefined
    ? undefined
    : items.find(item => item.sessionIds?.includes(current))
  const currentId = currentItem === undefined ? undefined : workspaceIdOf(currentItem)
  if (currentId !== undefined)
    return currentId
  if (workspaces.recentWorkspaceId !== undefined
    && items.some(item => workspaceIdOf(item) === workspaces.recentWorkspaceId)) {
    return workspaces.recentWorkspaceId
  }
  return items.map(workspaceIdOf).find((id): id is string => id !== undefined)
}
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function workspaceIdOf(item: WorkspaceItem): string | undefined {
  return item.workspaceId ?? item.id
}
