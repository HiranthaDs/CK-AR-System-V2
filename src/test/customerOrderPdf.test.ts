import { describe, expect, it } from 'vitest'
import { createCustomerOrderPdfBlob, customerOrderPdfFilename } from '../lib/customerOrderPdf'
import type { CompanyProfile, CustomerOrder } from '../types/api'

const company: CompanyProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  code: 'CK',
  name: 'CK Plastic',
  address: 'No. 242/A, Gorokgoda, Millewa, Harana, Sri Lanka.',
  phone: '0774881490 / 0712374024',
  email: 'info@ckplasticsl.com',
  is_active: true,
}

const order: CustomerOrder = {
  id: '10000000-0000-4000-8000-000000000001',
  order_no: 'ORD/2026:0042',
  customer_name: 'Sample Customer',
  customer_phone: '0771234567',
  customer_email: 'customer@example.com',
  customer_address: '42 Sample Road, Colombo',
  notes: 'Call before delivery.',
  status: 'pending',
  subtotal: 2400,
  total_amount: 2400,
  source: 'catalogue',
  created_at: '2026-11-24T08:30:00.000Z',
  updated_at: '2026-11-24T08:30:00.000Z',
  status_updated_at: '2026-11-24T08:30:00.000Z',
  customer_order_items: [{
    id: 1,
    order_id: '10000000-0000-4000-8000-000000000001',
    item_id: '20000000-0000-4000-8000-000000000001',
    product_name: 'Frame stand',
    product_category: 'Stands',
    product_description: 'Blue frame stand',
    quantity: 2,
    unit_price: 1200,
    line_total: 2400,
  }],
}

describe('customer order shipping PDF', () => {
  it('creates a safe descriptive filename', () => {
    expect(customerOrderPdfFilename({ order, company }))
      .toBe('Shipping_Order_ORD-2026-0042_Sample_Customer.pdf')
  })

  it('generates a non-empty shipping document', async () => {
    const blob = await createCustomerOrderPdfBlob({ order, company })
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(1_000)
  })
})
