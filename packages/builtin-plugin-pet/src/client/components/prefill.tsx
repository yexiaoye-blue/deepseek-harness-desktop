import { useWatchImmediate } from 'dsh-tauri/client'
import { useStore } from '../sdk'
import { store } from '../store'

export interface ConversationInputLeftProps {
  inputActions: {
    setDraft: (text: string) => void
  }
  sessionId: string
}
export function PetPrefill({ sessionId, inputActions }: ConversationInputLeftProps): null {
  const { prefills } = useStore(store.pet)
  const draft = prefills[sessionId]
  useWatchImmediate([draft, inputActions, sessionId], () => {
    const taken = store.pet.takePrefill(sessionId)
    if (taken === undefined)
      return
    inputActions.setDraft(taken)
  })
  return null
}
