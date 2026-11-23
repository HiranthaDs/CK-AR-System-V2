import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'
import { api } from '../lib/api'
import { autoChipStockNameForConversion, CONVERSION_TYPE_OPTIONS, conversionTypeForBulkMaterial } from '../lib/conversionSetup'
import { ProductionPage } from '../pages/ProductionPage'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('production conversions', () => {
  it('matches every standard Bulk RM name to its saved conversion type', () => {
    const bulkMaterials = [
      'ABS - Acrylonitrile Butadiene Styrene',
      'HIPS - High Impact Polystyrene',
      'PP - Polypropylene',
      'HDPE - High Density Polyethylene',
      'LDPE - Low Density Polyethylene',
      'LLDPE - Linear Low Density Polyethylene',
      'PET - Polyethylene Terephthalate',
      'PVC - Polyvinyl Chloride',
      'Black Masterbatch',
      'Color Masterbatch',
    ]
    const types = CONVERSION_TYPE_OPTIONS.map((name, index) => ({ id: String(index), name }))

    expect(bulkMaterials.map((material) => conversionTypeForBulkMaterial(types, material)?.name)).toEqual(CONVERSION_TYPE_OPTIONS)
    expect(autoChipStockNameForConversion('ABS Bulk to ABS Chip', 'ABS Chip')).toBe('Auto ABS Chip')
    expect(autoChipStockNameForConversion('Black Masterbatch Bulk to Chip', 'Black Masterbatch Chip')).toBe('Auto Black Masterbatch Chip')
  })

  it('orders and auto-fills new conversions, displays their type, and saves edits as corrections', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const conversionId = '00000000-0000-4000-8000-000000000010'
    const absTypeId = '00000000-0000-4000-8000-000000000011'
    const hipsTypeId = '00000000-0000-4000-8000-000000000012'
    const bulkId = '00000000-0000-4000-8000-000000000013'
    const chipId = '00000000-0000-4000-8000-000000000014'
    const workerId = '00000000-0000-4000-8000-000000000015'
    const rateId = '00000000-0000-4000-8000-000000000016'
    const conversion = {
      id: conversionId,
      reference_no: 'CNV-000010',
      conversion_date: '2026-11-20',
      conversion_type_id: absTypeId,
      source_item_id: bulkId,
      output_item_id: chipId,
      chip_type: 'ABS Bulk to ABS Chip',
      input_kg: 90,
      output_kg: 80,
      labor_cost: 800,
      overhead_cost: 100,
      status: 'posted',
      source_item: { name: 'ABS - Acrylonitrile Butadiene Styrene', sku: 'BLK-ABS' },
      output_item: { name: 'ABS', sku: 'CHP-ABS' },
      conversion_type: { id: absTypeId, name: 'ABS Bulk to ABS Chip', default_chip_name: 'ABS Chip' },
      conversion_workers: [{
        id: '00000000-0000-4000-8000-000000000017',
        employee_id: workerId,
        rate_id: rateId,
        task: 'Grinding',
        quantity_kg: 80,
        rate_per_kg: 10,
        amount: 800,
        employee: { name: 'Production Worker', employee_no: 'EMP-001' },
      }],
    }
    vi.spyOn(api, 'get').mockResolvedValue({
      as_of: '2026-11-20', month: '2026-11', today_runs: 0, today_input_kg: 0,
      today_output_quantity: 0, month_runs: 0, month_input_kg: 0, month_output_quantity: 0,
      bulk_item_count: 1, chip_item_count: 1, bulk_value: 0, chip_value: 0, recent_daily: [],
    })
    vi.spyOn(api, 'list').mockImplementation((path) => {
      const items = path === '/conversions' ? [conversion]
        : path === '/conversion-types' ? [
          { id: absTypeId, name: 'ABS Bulk to ABS Chip', default_chip_name: 'ABS Chip', status: 'active' },
          { id: hipsTypeId, name: 'HIPS Bulk to HIPS Chip', default_chip_name: 'HIPS Chip', status: 'active' },
        ]
          : path === '/piecework-rates' ? [{
            id: rateId, conversion_type_id: absTypeId, work_type: 'Grinding', rate_per_kg: 10,
            effective_from: '2026-01-01', status: 'active',
          }]
            : path === '/inventory/bulk' ? [{
              item_id: bulkId, item_name: 'ABS - Acrylonitrile Butadiene Styrene', stage: 'bulk',
              unit: 'kg', quantity_on_hand: 90, shared_quantity_on_hand: 90, inventory_value: 27000,
              average_unit_cost: 300, is_active: true,
            }]
              : path === '/employees' ? [{ id: workerId, name: 'Production Worker', employee_no: 'EMP-001', status: 'active' }]
                : []
      return Promise.resolve({ items, total: items.length, page: 1, page_size: 100, pages: items.length ? 1 : 0 })
    })
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      ok: true,
      operation: 'conversion.post',
      id: '00000000-0000-4000-8000-000000000019',
      reference_no: 'CNV-000012',
      idempotent: false,
    })
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({
      ok: true,
      operation: 'conversion.replace',
      id: '00000000-0000-4000-8000-000000000018',
      reference_no: 'CNV-000011',
      idempotent: false,
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider><ProductionPage /></ToastProvider>
      </QueryClientProvider>,
    )

    await user.click(screen.getByRole('tab', { name: 'Conversions' }))
    expect(await screen.findByText('CNV-000010')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Conversion type' })).toBeInTheDocument()
    expect(screen.getByText('ABS Bulk to ABS Chip')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reverse' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'New conversion' }))
    let dialog = screen.getByRole('dialog', { name: 'Post bulk-to-chip conversion' })
    const grid = dialog.querySelector('.form-grid--three')
    const firstFiveLabels = Array.from(grid?.children ?? []).slice(0, 5).map((child) => child.querySelector('.field__label')?.textContent?.replace(/\s*\*\s*$/, '').trim())
    expect(firstFiveLabels).toEqual(['Bulk material', 'Conversion type', 'Conversion date', 'Input kg', 'Chip stock name'])
    expect(within(dialog).getByText('Chip stock name').closest('label')).toHaveClass('field--span-2')

    const bulkMaterial = within(dialog).getByRole('combobox', { name: 'Bulk material' })
    await user.click(bulkMaterial)
    await user.click(await screen.findByRole('option', { name: /ABS - Acrylonitrile Butadiene Styrene.*90 kg available/ }))
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Conversion type' })).toHaveValue(absTypeId))
    expect(within(dialog).getByRole('spinbutton', { name: 'Input kg' })).toHaveValue(90)
    expect(within(dialog).getByRole('spinbutton', { name: 'Input kg' })).toHaveAttribute('max', '90')
    expect(within(dialog).getByRole('textbox', { name: 'Chip stock name' })).toHaveValue('Auto ABS Chip')
    expect(within(dialog).getByRole('textbox', { name: 'Chip stock name' })).toHaveAttribute('readonly')

    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Conversion type' }), hipsTypeId)
    expect(within(dialog).getByRole('textbox', { name: 'Chip stock name' })).toHaveValue('Auto HIPS Chip')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Conversion type' }), absTypeId)
    await user.click(within(dialog).getByRole('combobox', { name: 'Worker 1' }))
    await user.click(await screen.findByRole('option', { name: /Production Worker.*EMP-001/ }))
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Input kg' }))
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Input kg' }), '91')
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Output kg' }), '80')
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Worker quantity 1' }), '80')
    await user.click(within(dialog).getByRole('button', { name: 'Post conversion & earnings' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Input cannot exceed the available 90 kg.')
    expect(post).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await user.click(screen.getByRole('button', { name: 'Actions' }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    dialog = screen.getByRole('dialog', { name: 'Correct bulk-to-chip conversion' })
    expect(within(dialog).getByRole('combobox', { name: 'Conversion type' })).toHaveValue(absTypeId)
    expect(within(dialog).getByRole('textbox', { name: 'Chip stock name' })).toHaveValue('ABS')
    expect(within(dialog).getByRole('spinbutton', { name: 'Input kg' })).toHaveValue(90)
    await user.click(within(dialog).getByRole('button', { name: 'Save correction' }))

    await waitFor(() => expect(patch).toHaveBeenCalledWith(`/conversions/${conversionId}`, expect.objectContaining({
      conversion_type_id: absTypeId,
      source_item_id: bulkId,
      chip_name: 'ABS',
      input_kg: 90,
      output_kg: 80,
    })))
  })
})
