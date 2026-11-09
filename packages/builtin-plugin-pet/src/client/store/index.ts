import type { PetStoreFacade } from './modules/pet'
import { createPetStoreFacade, createPetStoreHandle } from './modules/pet'

let mounted: PetStoreFacade | undefined
export function mountPetStore(): PetStoreFacade {
  if (mounted)
    return mounted
  const handle = createPetStoreHandle()
  mounted = createPetStoreFacade(handle.create())
  return mounted
}
export function unmountPetStore(): void {
  mounted = undefined
}
export const store = {
  get pet(): PetStoreFacade {
    if (!mounted) {
      throw new Error('PET_STORE_NOT_MOUNTED: the pet store must be mounted by apply() before use')
    }
    return mounted
  },
}
