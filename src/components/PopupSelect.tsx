import { Check, ChevronDown, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Input } from './UI'

export interface PopupSelectOption {
  value: string
  label: string
  description?: string
}

export function PopupSelect({
  label,
  value,
  onChange,
  options,
  placeholder = 'Select an option',
  searchPlaceholder = 'Search options…',
  disabled = false,
  allowCustom = false,
  customPlaceholder = 'Type a custom value',
  maxLength = 160,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: readonly PopupSelectOption[]
  placeholder?: string
  searchPlaceholder?: string
  disabled?: boolean
  allowCustom?: boolean
  customPlaceholder?: string
  maxLength?: number
}) {
  const titleId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = options.find((option) => option.value === value)
  const custom = Boolean(value) && !selected
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    if (!term) return options
    return options.filter((option) => `${option.label} ${option.description ?? ''}`.toLocaleLowerCase().includes(term))
  }, [options, search])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    document.body.classList.add('popup-select-open')
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus())
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', close)
    return () => {
      window.cancelAnimationFrame(frame)
      document.body.classList.remove('popup-select-open')
      document.removeEventListener('keydown', close)
      previous?.focus()
    }
  }, [open])

  const choose = (next: string) => {
    onChange(next)
    setOpen(false)
    setSearch('')
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="popup-select__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span className={value ? '' : 'popup-select__placeholder'}>{selected?.label ?? (value || placeholder)}</span>
        <ChevronDown size={17} aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              className="popup-select__backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false)
              }}
            >
              <section className="popup-select__panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
                <header className="popup-select__header">
                  <div>
                    <strong id={titleId}>{label}</strong>
                    <small>Search, review, then choose once.</small>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setOpen(false)}
                    aria-label={`Close ${label}`}
                  >
                    <X size={18} />
                  </button>
                </header>
                <label className="popup-select__search">
                  <Search size={17} aria-hidden="true" />
                  <Input
                    ref={searchRef}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={searchPlaceholder}
                    aria-label={`Search ${label}`}
                  />
                  {search ? (
                    <button type="button" onClick={() => setSearch('')} aria-label={`Clear ${label} search`}>
                      <X size={15} />
                    </button>
                  ) : null}
                </label>
                <div className="popup-select__results" role="listbox" aria-label={`${label} options`}>
                  {!filtered.length ? (
                    <div className="popup-select__empty">
                      No matching options. {allowCustom ? 'Enter a custom value below.' : 'Try another search.'}
                    </div>
                  ) : null}
                  {filtered.map((option) => {
                    const active = option.value === value
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={
                          active ? 'popup-select__option popup-select__option--active' : 'popup-select__option'
                        }
                        key={option.value}
                        onClick={() => choose(option.value)}
                      >
                        <span>
                          <strong>{option.label}</strong>
                          {option.description ? <small>{option.description}</small> : null}
                        </span>
                        {active ? <Check size={18} aria-hidden="true" /> : null}
                      </button>
                    )
                  })}
                </div>
                {allowCustom ? (
                  <div className="popup-select__custom">
                    <span>Custom value</span>
                    <div>
                      <Input
                        value={custom ? value : ''}
                        maxLength={maxLength}
                        placeholder={customPlaceholder}
                        onChange={(event) => onChange(event.target.value.slice(0, maxLength))}
                      />
                      <button
                        type="button"
                        className="button button--primary button--small"
                        disabled={!custom || !value.trim()}
                        onClick={() => choose(value.trim())}
                      >
                        Use value
                      </button>
                    </div>
                  </div>
                ) : null}
                {value ? (
                  <footer className="popup-select__footer">
                    <button type="button" className="button button--ghost button--small" onClick={() => choose('')}>
                      Clear selection
                    </button>
                  </footer>
                ) : null}
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
