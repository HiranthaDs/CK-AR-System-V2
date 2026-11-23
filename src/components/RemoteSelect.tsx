import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, LoaderCircle, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type ApiQuery } from '../lib/api'
import { Field, Input } from './UI'

interface RemoteSelectProps<T> {
  label: string
  endpoint: string
  queryKey: string
  value: string
  onChange: (value: string) => void
  onSelectItem?: (item: T | undefined) => void
  optionValue: (item: T) => string
  optionLabel: (item: T) => string
  query?: ApiQuery | undefined
  required?: boolean | undefined
  disabled?: boolean | undefined
  error?: string | undefined
  selectedLabel?: string | undefined
  placeholder?: string | undefined
  searchPlaceholder?: string | undefined
  compact?: boolean | undefined
}

interface PopupPosition {
  left: number
  width: number
  maxHeight: number
  top?: number
  bottom?: number
}

/** Searchable, server-filtered popup picker for large master tables. */
export function RemoteSelect<T>({
  label,
  endpoint,
  queryKey,
  value,
  onChange,
  onSelectItem,
  optionValue,
  optionLabel,
  query,
  required,
  disabled,
  error,
  selectedLabel,
  placeholder = 'Select a record',
  searchPlaceholder = 'Type to filter…',
  compact = false,
}: RemoteSelectProps<T>) {
  const listId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [position, setPosition] = useState<PopupPosition | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  const result = useQuery({
    queryKey: ['lookup', queryKey, query ?? {}, debouncedSearch],
    queryFn: ({ signal }) => api.list<T>(endpoint, {
      ...query,
      q: debouncedSearch,
      page: 1,
      page_size: 50,
      descending: false,
    }, signal),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  const options = result.data?.items ?? []
  const selectedItem = options.find((item) => optionValue(item) === value)
  const displayValue = selectedItem
    ? optionLabel(selectedItem)
    : value
      ? selectedLabel || `Selected · ${value.slice(0, 8)}`
      : placeholder

  const updatePosition = () => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const edge = 12
    const gap = 8
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const width = Math.min(Math.max(rect.width, 320), viewportWidth - edge * 2)
    const left = Math.min(Math.max(edge, rect.left), viewportWidth - width - edge)
    const below = viewportHeight - rect.bottom - edge
    const above = rect.top - edge

    if (below >= 260 || below >= above) {
      setPosition({ left, width, top: rect.bottom + gap, maxHeight: Math.max(190, below - gap) })
    } else {
      setPosition({ left, width, bottom: viewportHeight - rect.top + gap, maxHeight: Math.max(190, above - gap) })
    }
  }

  useEffect(() => {
    if (!open) return
    updatePosition()
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus())
    const reposition = () => updatePosition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [open])

  const choose = (item: T | undefined) => {
    const nextValue = item ? optionValue(item) : ''
    onChange(nextValue)
    onSelectItem?.(item)
    setOpen(false)
    setSearch('')
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const control = (
    <div className={`remote-select${compact ? ' remote-select--compact' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="remote-select__trigger"
        role="combobox"
        aria-label={label}
        aria-controls={listId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={Boolean(error)}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className={value ? undefined : 'remote-select__placeholder'}>{displayValue}</span>
        {result.isFetching ? <LoaderCircle className="spin" size={16} aria-label="Loading options" /> : <ChevronDown className={open ? 'remote-select__chevron remote-select__chevron--open' : 'remote-select__chevron'} size={17} aria-hidden="true" />}
      </button>
      {result.isError && !open ? <span className="field__error">Could not load options. Open the picker to retry.</span> : null}
      {open && !disabled && position ? createPortal(
        <div
          ref={popupRef}
          className="remote-select__popup"
          style={{
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
            ...(position.top === undefined ? {} : { top: position.top }),
            ...(position.bottom === undefined ? {} : { bottom: position.bottom }),
          }}
        >
          <div className="remote-select__search">
            <Search size={17} aria-hidden="true" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={`Search ${label}`}
              autoComplete="off"
            />
            {search ? <button type="button" className="remote-select__clear" onClick={() => setSearch('')} aria-label={`Clear ${label} search`}><X size={15} /></button> : null}
          </div>
          <div className="remote-select__meta">
            <span>{debouncedSearch ? `Results for “${debouncedSearch}”` : `Choose ${label.toLowerCase()}`}</span>
            <small>{result.data?.total ?? options.length} found</small>
          </div>
          <div className="remote-select__options" id={listId} role="listbox" aria-label={`${label} options`}>
            {!required && value ? <button type="button" className="remote-select__option remote-select__option--clear" role="option" aria-selected="false" onClick={() => choose(undefined)}>Clear selection</button> : null}
            {result.isLoading && !options.length ? <div className="remote-select__state"><LoaderCircle className="spin" size={19} />Loading options…</div> : null}
            {result.isError ? <div className="remote-select__state remote-select__state--error">Options could not be loaded. Change the search to retry.</div> : null}
            {!result.isLoading && !result.isError && !options.length ? <div className="remote-select__state">No matching records found.</div> : null}
            {options.map((item) => {
              const option = optionValue(item)
              const selected = option === value
              return (
                <button
                  type="button"
                  className={`remote-select__option${selected ? ' remote-select__option--selected' : ''}`}
                  role="option"
                  aria-selected={selected}
                  key={option}
                  onClick={() => choose(item)}
                >
                  <span>{optionLabel(item)}</span>
                  {selected ? <Check size={17} aria-hidden="true" /> : null}
                </button>
              )
            })}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )

  if (compact) return control

  return (
    <Field label={label} required={required} error={error}>
      {control}
    </Field>
  )
}
