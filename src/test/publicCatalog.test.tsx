import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicApi } from '../lib/api'
import { PublicCatalogPage } from '../pages/PublicCatalogPage'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('public catalogue quantities', () => {
  it('lets a customer type the exact quantity', async () => {
    const user = userEvent.setup()
    vi.spyOn(publicApi, 'get').mockResolvedValue({
      items: [{
        id: '10000000-0000-4000-8000-000000000001',
        sku: 'CRATE-01',
        name: 'Blue crate',
        category: 'Crates',
        selling_price: 500,
        description: 'Stackable blue crate',
      }],
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><PublicCatalogPage /></MemoryRouter>
      </QueryClientProvider>,
    )

    await user.click(await screen.findByRole('button', { name: 'Add' }))
    const quantityInput = screen.getByRole('spinbutton', { name: 'Blue crate quantity' })
    await user.clear(quantityInput)
    await user.type(quantityInput, '24')

    expect(quantityInput).toHaveValue(24)
    expect(screen.getByText('24 items')).toBeInTheDocument()
  })
})
