import type { PublicCatalogItem, PublicOrderReceipt } from '../types/api'
import { money } from './format'

export const CATALOG_ORDER_WHATSAPP_NUMBER = '94712374024'

export interface CatalogWhatsAppOrderInput {
  receipt: PublicOrderReceipt
  customer: {
    name: string
    phone: string
    email?: string
    address?: string
    notes?: string
  }
  lines: Array<{
    product: PublicCatalogItem
    quantity: number
  }>
}

export function catalogOrderWhatsAppMessage({ receipt, customer, lines }: CatalogWhatsAppOrderInput) {
  const details = [
    `New catalogue order: ${receipt.order_no}`,
    '',
    `Customer: ${customer.name}`,
    `Phone: ${customer.phone}`,
    customer.email ? `Email: ${customer.email}` : null,
    customer.address ? `Delivery address: ${customer.address}` : 'Delivery address: Not provided',
    '',
    'Items:',
    ...lines.map((line, index) => {
      const unitPrice = Number(line.product.selling_price)
      return `${index + 1}. ${line.product.name} x ${line.quantity} @ ${money(unitPrice)} = ${money(unitPrice * line.quantity)}`
    }),
    '',
    `Order total: ${money(receipt.total_amount)}`,
    customer.notes ? `Notes: ${customer.notes}` : null,
  ].filter((line): line is string => line !== null)

  return details.join('\n')
}

export function catalogOrderWhatsAppUrl(input: CatalogWhatsAppOrderInput) {
  return `https://wa.me/${CATALOG_ORDER_WHATSAPP_NUMBER}?text=${encodeURIComponent(catalogOrderWhatsAppMessage(input))}`
}

export function openCatalogOrderWhatsApp(url: string, location: Pick<Location, 'assign'> = window.location) {
  location.assign(url)
}
