import type { SVGProps } from 'react'

type IconName =
  | 'alert' | 'arrow-down' | 'arrow-down-to-line' | 'arrow-up' | 'breakpoint'
  | 'check' | 'chevron-down' | 'chevron-right' | 'close' | 'collapse-all'
  | 'copy' | 'deselect' | 'expand-all' | 'filter' | 'globe'
  | 'hash' | 'link' | 'list-x' | 'loader' | 'minus-circle'
  | 'moon' | 'plus' | 'plus-circle' | 'refresh' | 'select-all'
  | 'send' | 'settings' | 'slash' | 'sliders' | 'sort-asc'
  | 'sort-desc' | 'star' | 'sun' | 'tag' | 'terminal'
  | 'toggle-off' | 'toggle-on' | 'trash' | 'websocket'

export function Icon({ name, size = 16, label, ...props }: SVGProps<SVGSVGElement> & {
  name: IconName
  size?: number
  label?: string
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined} aria-label={label} {...props}>
      <use href={`/icons.svg#${name}`} />
    </svg>
  )
}
