import { PLUGIN_ID } from '../../shared/constants'

export const PET_SECTION_ID = 'dsh-pet-lite-settings'
export const PET_SECTION_ORDER = 210
export const PET_LOCALE_EFFECT = `${PLUGIN_ID}: locale`
export const PET_SECTION_EFFECT = `${PLUGIN_ID}: settings section`
export const PET_PREFILL_EFFECT = `${PLUGIN_ID}: conversation prefill`
export const PET_MENU_EFFECT = `${PLUGIN_ID}: settings menu items`
export const CONVERSATION_INPUT_LEFT_SLOT = 'conversation.input.left'
export const PET_PREFILL_ID = 'dsh-pet-lite-prefill'
export const PET_PREFILL_ORDER = 230
export const PET_PREFILL_PRIORITY = 0
export const PET_HATCH_PROMPT = '/hatch-dsh-pet 根据你对我的了解，养一只宠物'
export const CMD_GET_PET_STATUS = 'get_pet_status'
export const CMD_SET_PET_ENABLED = 'set_pet_enabled'
export const CMD_SET_ACTIVE_PET = 'set_active_pet'
export const CMD_SET_PET_SIZE = 'set_pet_size'
export const CMD_SET_PET_THROW_ENABLED = 'set_pet_throw_enabled'
export const CMD_LIST_PETS = 'list_pets'
export const CMD_IMPORT_PET = 'import_pet'
export const CMD_DELETE_PET = 'delete_pet'
export const CMD_IMPORT_PET_REPOSITORY = 'import_pet_repository'
export const CMD_UPDATE_PET_REPOSITORY = 'update_pet_repository'
export const CMD_LIST_PRESET_PETS = 'list_preset_pets'
export const CMD_CHECK_PET_UPDATES = 'check_pet_updates'
export const CMD_OPEN_EXTERNAL_URL = 'open_external_url'
export const PET_COMMUNITY_URL = 'https://codex-pets.net/#/'
export const SETTINGS_MENU_LABELS: readonly string[] = ['设置', 'Settings']
export const MENU_ITEM_SELECTOR = 'button[role="menuitem"]'
export const MENU_ITEM_LABEL_SELECTOR = '[class*="itemLabel"]'
export const MENU_ITEM_ICON_SELECTOR = '[class*="itemIcon"]'
export const MENU_ITEM_SHORTCUT_SELECTOR = '[class*="shortcut"]'
export const PET_MENU_ITEM_ATTRIBUTE = 'data-dsh-pet-lite-menu-item'
export const PET_MENU_PATCH_ATTRIBUTE = 'data-dsh-pet-lite-menu-patched'
export const PET_DEFAULT_SIZE = 100
export const PET_SIZE_MIN = 50
export const PET_SIZE_MAX = 200
export const PET_SIZE_STEP = 5
