import { PLUGIN_ID } from '../../shared/constants'
import { PetPrefill } from '../components/prefill'
import { CONVERSATION_INPUT_LEFT_SLOT, PET_PREFILL_ID, PET_PREFILL_ORDER, PET_PREFILL_PRIORITY } from '../constants'
import { defineRegister } from '../sdk'

export const prefillFeature = defineRegister((controller, ctx) => {
  controller.add(ctx.slots.inject(CONVERSATION_INPUT_LEFT_SLOT, () => ctx.slots.register({
    name: CONVERSATION_INPUT_LEFT_SLOT,
    id: PET_PREFILL_ID,
    order: PET_PREFILL_ORDER,
    priority: PET_PREFILL_PRIORITY,
    registrant: PLUGIN_ID,
    inject: (sessionId: string) => ({ sessionId }),
  } as never, PetPrefill as never)))
})
