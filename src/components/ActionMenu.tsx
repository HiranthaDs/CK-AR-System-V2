import { ChevronDown } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Button } from './UI'

export function ActionMenu({ children, label = 'Actions' }: { children: ReactNode; label?: string | undefined }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const placeMenu = useCallback(() => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return
    const triggerRect = trigger.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const width = Math.max(menuRect.width, 176)
    const height = menuRect.height
    const left = Math.max(8, Math.min(triggerRect.right - width, window.innerWidth - width - 8))
    const roomBelow = window.innerHeight - triggerRect.bottom
    const top = roomBelow >= height + 14
      ? triggerRect.bottom + 6
      : Math.max(8, triggerRect.top - height - 6)
    setPosition({ top, left })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    placeMenu()
  }, [open, placeMenu])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', placeMenu)
    window.addEventListener('scroll', placeMenu, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', placeMenu)
      window.removeEventListener('scroll', placeMenu, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, placeMenu])

  const closeAfterAction = (event: MouseEvent<HTMLDivElement>) => {
    const button = (event.target as Element).closest('button')
    if (button && !button.disabled) setOpen(false)
  }

  return (
    <div className="action-menu">
      <Button
        ref={triggerRef}
        type="button"
        size="small"
        variant="secondary"
        className="action-menu__trigger"
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        {label}<ChevronDown size={15} aria-hidden="true" />
      </Button>
      {open ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="action-menu__popover"
          role="group"
          aria-label={label}
          style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}
          onClick={closeAfterAction}
        >
          {children}
        </div>,
        document.body,
      ) : null}
    </div>
  )
}
