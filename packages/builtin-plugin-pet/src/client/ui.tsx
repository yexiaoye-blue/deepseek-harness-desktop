import type { ComponentType, ReactElement, ReactNode } from 'react'
import { IconGlobeOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular, Button as OfficialButton, Input as OfficialInput, Modal as OfficialModal, SegmentedControl as OfficialSegmentedControl, Switch as OfficialSwitch } from '@deepseek-ai/dsh-client-ui-primitives'
import { Ghost as GhostArtwork } from './ghost'

export interface IconArtworkProps {
  size?: number | undefined
  className?: string | undefined
}
export { OfficialButton as Button, OfficialInput as Input, OfficialSegmentedControl as SegmentedControl }
export function Modal(props: {
  children?: ReactNode
  className?: string
  closeLabel: string
  description?: string
  footer?: ReactNode
  onClose: () => void
  open: boolean
  title: string
}): ReactElement {
  return (
    <OfficialModal open={props.open} onClose={props.onClose} title={props.title} description={props.description} closeLabel={props.closeLabel} footer={props.footer} className={props.className}>
      {props.children}
    </OfficialModal>
  )
}
export function Switch(props: {
  checked: boolean
  className?: string
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
  title?: string
}): ReactElement {
  return (<OfficialSwitch checked={props.checked} onChange={props.onChange} label={props.label} disabled={props.disabled} title={props.title} className={props.className} />)
}
export function Action(props: {
  'aria-label'?: string
  'children'?: ReactNode
  'className'?: string
  'disabled'?: boolean
  'onClick'?: () => void
  'title'?: string
  'variant'?: 'action'
}): ReactElement {
  return (
    <OfficialButton type="button" variant="ghost" size="sm" aria-label={props['aria-label']} title={props.title} disabled={props.disabled} className={props.className} onClick={props.onClick}>
      {props.children}
    </OfficialButton>
  )
}
export function Icon(props: {
  as?: ComponentType<IconArtworkProps>
  className?: string
  size?: number
}): ReactElement | null {
  const Artwork = props.as
  if (!Artwork)
    return null
  return <Artwork size={props.size} className={props.className} />
}
export const Plus = IconPlusOutlineRegular
export const Globe = IconGlobeOutlineRegular
export const TrashBin = IconTrashOutlineRegular
export const Ghost = GhostArtwork
export const ArrowRightFromSquare = IconGlobeOutlineRegular
