export const CONVERSION_TYPE_OPTIONS = [
  'ABS Bulk to ABS Chip',
  'HIPS Bulk to HIPS Chip',
  'PP Bulk to PP Chip',
  'HDPE Bulk to HDPE Chip',
  'LDPE Bulk to LDPE Chip',
  'LLDPE Bulk to LLDPE Chip',
  'PET Bulk to PET Chip',
  'PVC Bulk to PVC Chip',
  'Black Masterbatch Bulk to Chip',
  'Color Masterbatch Bulk to Chip',
] as const

export const WORK_TYPE_OPTIONS = [
  'Grinding',
  'Washing',
  'Sorting',
  'Grinding & Washing',
  'Shredding',
  'Cutting',
] as const

export function chipStockNameForConversion(conversionType: string) {
  const normalized = conversionType.trim()
  if (!normalized) return ''
  const parts = normalized.split(/\s+to\s+/i)
  if (parts.length > 1) {
    const target = parts.at(-1)?.trim() ?? ''
    if (target.toLowerCase() !== 'chip') return target
    const source = (parts[0] ?? '').replace(/\s+bulk$/i, '').trim()
    return source ? `${source} Chip` : target
  }
  const shortName = normalized.split(/\s+/)[0]
  return shortName ? `${shortName} Chip` : ''
}
