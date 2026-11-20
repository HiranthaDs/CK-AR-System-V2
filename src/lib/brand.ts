import type { jsPDF } from 'jspdf'
import logoUrl from '../../Logo.png?inline'

export const BRAND_LOGO_URL = logoUrl

const LOGO_ASPECT_RATIO = 865 / 513

export function addBrandLogo(
  document: jsPDF,
  { x, y, maxWidth, maxHeight }: { x: number; y: number; maxWidth: number; maxHeight: number },
) {
  let width = maxWidth
  let height = width / LOGO_ASPECT_RATIO
  if (height > maxHeight) {
    height = maxHeight
    width = height * LOGO_ASPECT_RATIO
  }

  document.addImage(BRAND_LOGO_URL, 'PNG', x, y, width, height, undefined, 'FAST')
  return { width, height }
}
