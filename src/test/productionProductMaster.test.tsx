import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'
import { api } from '../lib/api'
import { ProductionPage } from '../pages/ProductionPage'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('production Product Master selection', () => {
  it('uses shift and product dropdowns and fills the exact saved selling price', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    vi.spyOn(api, 'get').mockResolvedValue({
      as_of: '2026-11-19', month: '2026-11', today_runs: 0, today_input_kg: 0,
      today_output_quantity: 0, month_runs: 0, month_input_kg: 0, month_output_quantity: 0,
      bulk_item_count: 0, chip_item_count: 0, bulk_value: 0, chip_value: 0, recent_daily: [],
    })
    const list = vi.spyOn(api, 'list').mockImplementation((path) => {
      const items = path === '/employees' ? [{
        id: '00000000-0000-4000-8000-000000000001', name: 'Production Worker', employee_no: 'EMP-001',
      }] : path === '/inventory/chips' ? [{
        item_id: '00000000-0000-4000-8000-000000000002', item_name: 'Black chips',
        quantity_on_hand: 100, average_unit_cost: 300,
      }] : path === '/products' ? [{
        id: '00000000-0000-4000-8000-000000000003', sku: 'PRD-001', name: 'Frame Stand Pro',
        stage: 'finished', unit: 'piece', is_active: true, product_type: 'Frame Stand', selling_price: 2250,
      }] : []
      return Promise.resolve({ items, total: items.length, page: 1, page_size: 50, pages: items.length ? 1 : 0 })
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider><ProductionPage /></ToastProvider>
      </QueryClientProvider>,
    )

    await user.click(await screen.findByRole('button', { name: 'Record production' }))
    const dialog = screen.getByRole('dialog', { name: 'Record production run' })

    expect(screen.queryByText('Existing final product (optional)')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Final product name' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Shift' }), 'Night')
    expect(screen.getByRole('combobox', { name: 'Shift' })).toHaveValue('Night')

    const productSelect = screen.getByRole('combobox', { name: 'Final product name' })
    await user.click(productSelect)
    await user.click(await screen.findByRole('option', { name: /Frame Stand Pro/ }))

    const sellingPrice = screen.getByLabelText<HTMLInputElement>(/Selling price/)
    expect(sellingPrice).toHaveValue(2250)
    expect(sellingPrice).toHaveAttribute('readonly')
    expect(screen.getByLabelText(/Product type/)).toHaveValue('Frame Stand')
    expect(dialog).toBeInTheDocument()
    await waitFor(() => expect(list).toHaveBeenCalledWith('/products', expect.objectContaining({
      active_only: true,
    }), expect.any(AbortSignal)))
  })
})
