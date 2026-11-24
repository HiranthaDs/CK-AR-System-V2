import { describe, expect, it } from 'vitest'
import { CATALOG_ORDER_WHATSAPP_NUMBER, catalogOrderWhatsAppMessage, catalogOrderWhatsAppUrl } from '../lib/catalogOrderWhatsApp'

const input = {
  receipt: {
    ok: true,
    order_no: 'ORD-0042',
    tracking_token: '10000000-0000-4000-8000-000000000001',
    status: 'pending' as const,
    total_amount: 12000,
    idempotent: false,
  },
  customer: {
    name: 'Sample Customer',
    phone: '0771234567',
    email: 'customer@example.com',
    address: '42 Sample Road, Colombo',
    notes: 'Call before delivery.',
  },
  lines: [{
    product: {
      id: '20000000-0000-4000-8000-000000000001',
      sku: 'CRATE-01',
      name: 'Blue crate',
      category: 'Crates',
      selling_price: 500,
    },
    quantity: 24,
  }],
}

describe('catalogue order WhatsApp handoff', () => {
  it('includes every saved order detail in the business message', () => {
    const message = catalogOrderWhatsAppMessage(input)
    for (const value of ['ORD-0042', 'Sample Customer', '0771234567', 'customer@example.com', '42 Sample Road', 'Blue crate x 24', '12,000.00', 'Call before delivery.']) {
      expect(message).toContain(value)
    }
  })

  it('targets the configured CK Plastics WhatsApp number', () => {
    expect(catalogOrderWhatsAppUrl(input)).toMatch(new RegExp(`^https://wa.me/${CATALOG_ORDER_WHATSAPP_NUMBER}\\?text=`))
  })
})
