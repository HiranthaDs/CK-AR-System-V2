import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversionTypeDialog, PieceworkRateDialog } from '../components/ConversionSetupDialogs'
import { ToastProvider } from '../components/Toast'
import { api } from '../lib/api'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderDialog(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>,
  )
}

describe('conversion setup dialogs', () => {
  it('offers standard conversion types, supports manual entry, and derives the chip name', async () => {
    const user = userEvent.setup()
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      ok: true,
      operation: 'conversion_type.upsert',
      id: '22222222-2222-4222-8222-222222222222',
      idempotent: false,
    })

    renderDialog(<ConversionTypeDialog open onClose={vi.fn()} />)

    const conversionType = screen.getByRole('combobox', { name: 'Conversion type' })
    expect(within(conversionType).getAllByRole('option')).toHaveLength(12)
    await user.selectOptions(conversionType, 'Black Masterbatch Bulk to Chip')
    expect(screen.getByRole('textbox', { name: /Default chip stock name/ })).toHaveValue('Black Masterbatch Chip')
    await user.selectOptions(conversionType, 'ABS Bulk to ABS Chip')
    expect(screen.getByRole('textbox', { name: /Default chip stock name/ })).toHaveValue('ABS Chip')

    await user.selectOptions(conversionType, '__manual__')
    await user.type(screen.getByRole('textbox', { name: 'Manual conversion type' }), 'Nylon Bulk to Nylon Chip')
    expect(screen.getByRole('textbox', { name: /Default chip stock name/ })).toHaveValue('Nylon Chip')
    await user.click(screen.getByRole('button', { name: 'Save type' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith('/conversion-types', {
      name: 'Nylon Bulk to Nylon Chip',
      default_chip_name: 'Nylon Chip',
      status: 'active',
      notes: null,
    }))
  })

  it('uses saved conversion types only and defaults work type to Grinding while allowing manual work', async () => {
    const user = userEvent.setup()
    const conversionTypeId = '11111111-1111-4111-8111-111111111111'
    vi.spyOn(api, 'list').mockResolvedValue({
      items: [{
        id: conversionTypeId,
        name: 'ABS Bulk to ABS Chip',
        default_chip_name: 'ABS Chip',
        status: 'active',
      }],
      total: 1,
      page: 1,
      page_size: 100,
      pages: 1,
    })
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      ok: true,
      operation: 'piecework_rate.upsert',
      id: '22222222-2222-4222-8222-222222222222',
      idempotent: false,
    })

    renderDialog(<PieceworkRateDialog open onClose={vi.fn()} />)

    const conversionType = screen.getByRole('combobox', { name: 'Rate conversion type' })
    await screen.findByRole('option', { name: 'ABS Bulk to ABS Chip' })
    expect(within(conversionType).queryByRole('option', { name: /Manual/i })).not.toBeInTheDocument()
    await user.selectOptions(conversionType, conversionTypeId)

    const workType = screen.getByRole('combobox', { name: 'Work type' })
    expect(workType).toHaveValue('Grinding')
    expect(within(workType).getByRole('option', { name: 'Grinding & Washing' })).toBeInTheDocument()
    await user.selectOptions(workType, '__manual__')
    await user.type(screen.getByRole('textbox', { name: 'Manual work type' }), 'Pelletizing')
    await user.clear(screen.getByRole('spinbutton', { name: 'Rate per kg' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Rate per kg' }), '12.5')
    await user.click(screen.getByRole('button', { name: 'Save rate' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith('/piecework-rates', expect.objectContaining({
      conversion_type_id: conversionTypeId,
      work_type: 'Pelletizing',
      rate_per_kg: 12.5,
    })))
  })

  it('preselects the saved conversion and work type when editing a rate', async () => {
    const user = userEvent.setup()
    const rateId = '22222222-2222-4222-8222-222222222222'
    const selectedTypeId = '11111111-1111-4111-8111-111111111111'
    const otherTypeId = '33333333-3333-4333-8333-333333333333'
    vi.spyOn(api, 'list').mockResolvedValue({
      items: [{
        id: otherTypeId,
        name: 'HIPS Bulk to HIPS Chip',
        default_chip_name: 'HIPS Chip',
        status: 'active',
      }],
      total: 1,
      page: 1,
      page_size: 100,
      pages: 1,
    })
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({
      ok: true,
      operation: 'piecework_rate.upsert',
      id: rateId,
      idempotent: false,
    })

    renderDialog(<PieceworkRateDialog open record={{
      id: rateId,
      work_type: 'Washing',
      rate_per_kg: 15,
      effective_from: '2026-11-20',
      effective_to: null,
      status: 'active',
      notes: 'Selected rate',
      conversion_type: {
        id: selectedTypeId,
        name: 'ABS Bulk to ABS Chip',
        default_chip_name: 'ABS Chip',
        status: 'active',
      },
    }} onClose={vi.fn()} />)

    const conversionType = screen.getByRole('combobox', { name: 'Rate conversion type' })
    await screen.findByRole('option', { name: 'HIPS Bulk to HIPS Chip' })
    expect(conversionType).toHaveValue(selectedTypeId)
    expect(within(conversionType).getByRole('option', { name: 'ABS Bulk to ABS Chip' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Work type' })).toHaveValue('Washing')
    expect(screen.getByRole('spinbutton', { name: 'Rate per kg' })).toHaveValue(15)

    await user.click(screen.getByRole('button', { name: 'Save rate' }))

    await waitFor(() => expect(patch).toHaveBeenCalledWith(`/piecework-rates/${rateId}`, expect.objectContaining({
      conversion_type_id: selectedTypeId,
      work_type: 'Washing',
      rate_per_kg: 15,
      effective_from: '2026-11-20',
    })))
  })
})
