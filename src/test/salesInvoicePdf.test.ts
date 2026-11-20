import { describe, expect, it } from 'vitest'
import { createSalesInvoicePdfBlob, salesInvoicePdfFilename } from '../lib/salesInvoicePdf'
import type { CompanyProfile, Sale } from '../types/api'

const company: CompanyProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  code: 'CK',
  name: 'CK Plastic',
  address: 'No. 242/A, Gorokgoda, Millewa, Harana, Sri Lanka.',
  phone: '0774881490 / 0712374024',
  email: 'info@ckplasticsl.com',
  is_active: true,
}

const sale: Sale = {
  id: '10000000-0000-4000-8000-000000000001',
  reference_no: 'SAL-202611-01',
  invoice_no: 'CK-INV-202611-0001',
  sale_date: '2026-11-20',
  customer_name: 'Sample Customer',
  customer_phone: '0771234567',
  payment_method: 'cash',
  document_status: 'delivered',
  status: 'posted',
  total_amount: 2400,
  paid_amount: 1000,
  balance_due: 1400,
  sale_payments: [],
  sale_items: [{
    id: '20000000-0000-4000-8000-000000000001',
    item_id: '30000000-0000-4000-8000-000000000001',
    quantity: 2,
    unit_price: 1250,
    discount: 100,
    line_total: 2400,
    item: { name: 'Frame stand', sku: 'CK-FS-01', unit: 'pcs' },
  }],
}

describe('sales invoice PDF', () => {
  it('uses the generated invoice number in a safe filename', () => {
    expect(salesInvoicePdfFilename({ sale, company }))
      .toBe('Invoice_CK-INV-202611-0001_Sample_Customer.pdf')
  })

  it('generates a branded non-empty customer invoice PDF', async () => {
    const blob = await createSalesInvoicePdfBlob({ sale, company })
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(1_000)
  })
})
