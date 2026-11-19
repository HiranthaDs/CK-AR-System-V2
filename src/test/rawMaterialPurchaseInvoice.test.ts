import { describe, expect, it } from 'vitest'
import {
  createRawMaterialPurchaseInvoicePdf,
  rawMaterialPurchaseInvoiceFilename,
  rawMaterialPurchaseWhatsAppMessage,
} from '../lib/rawMaterialPurchaseInvoice'
import type { CompanyProfile, RawMaterialPurchase } from '../types/api'

const company: CompanyProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  code: 'CK',
  name: 'CK Plastics',
  address: 'Colombo, Sri Lanka',
  phone: '+94 77 123 4567',
  email: 'accounts@example.com',
  is_active: true,
}

const purchase: RawMaterialPurchase = {
  id: '10000000-0000-4000-8000-000000000001',
  company_id: company.id,
  reference_no: 'RMC-20261119-01',
  invoice_no: 'RM-CKP-0001',
  purchase_date: '2026-11-19',
  supplier_name: 'Polymer Supplier',
  supplier_phone: '+94 71 234 5678',
  lorry_no: 'WP AB-1234',
  payment_method: 'credit',
  grand_total: 230000,
  status: 'posted',
  purchase_items: [{
    id: '20000000-0000-4000-8000-000000000001',
    reference_no: 'RMP-01',
    item_id: '30000000-0000-4000-8000-000000000001',
    quantity_kg: 500,
    rate_per_kg: 320,
    total_cost: 160000,
    status: 'posted',
    inventory_items: { name: 'ABS' },
  }, {
    id: '20000000-0000-4000-8000-000000000002',
    reference_no: 'RMP-02',
    item_id: '30000000-0000-4000-8000-000000000002',
    quantity_kg: 250,
    rate_per_kg: 280,
    total_cost: 70000,
    notes: 'Black bags only',
    status: 'posted',
    inventory_items: { name: 'Packing Bags' },
  }],
}

describe('raw-material purchase invoice', () => {
  it('uses the saved invoice number and supplier payment summary', () => {
    expect(rawMaterialPurchaseInvoiceFilename({ purchase, company })).toBe('Raw_Material_Purchase_RM-CKP-0001.pdf')
    const message = rawMaterialPurchaseWhatsAppMessage(purchase)
    expect(message).toContain('Polymer Supplier')
    expect(message).toContain('RM-CKP-0001')
    expect(message).toContain('WP AB-1234')
  })

  it('generates a non-empty PDF containing all saved lines', async () => {
    const blob = await createRawMaterialPurchaseInvoicePdf({ purchase, company })
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(1_000)
  })
})
