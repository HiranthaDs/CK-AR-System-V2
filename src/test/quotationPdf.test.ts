import { describe, expect, it } from 'vitest'
import { quotationPdfFilename, quotationWhatsAppMessage } from '../lib/quotationPdf'
import type { Quotation } from '../types/api'

const quotation: Quotation = {
  id: 'quotation-1',
  reference_no: 'QUO-0001',
  quotation_no: 'Q/2026:001',
  quotation_date: '2026-11-18',
  valid_until: '2026-12-02',
  customer_name: 'Sample Customer',
  customer_phone: '0771234567',
  subtotal: 2500,
  discount_total: 100,
  total_amount: 2400,
  status: 'draft',
  quotation_items: [],
}

describe('quotation PDF helpers', () => {
  it('creates a safe descriptive PDF filename', () => {
    expect(quotationPdfFilename({ quotation, companyName: 'CK Products' }))
      .toBe('Quotation_Q-2026-001_Sample_Customer.pdf')
  })

  it('creates a concise customer sharing message', () => {
    const message = quotationWhatsAppMessage(quotation)
    expect(message).toContain('quotation Q/2026:001')
    expect(message).toContain('2,400.00')
    expect(message).toContain('02 Dec 2026')
  })
})
