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

export function chipStockBaseNameForConversion(conversionType: string, defaultChipName?: string | null) {
  const chipName = defaultChipName?.trim() || chipStockNameForConversion(conversionType)
  return chipName.replace(/\s+chip$/i, '').trim()
}

function materialKey(value: string) {
  const shortName = value.split(/\s+-\s+/, 1)[0]?.replace(/\s+bulk$/i, '').trim() ?? ''
  return shortName.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function conversionTypeForBulkMaterial<T extends { name: string }>(types: readonly T[], bulkMaterialName: string) {
  const bulkKey = materialKey(bulkMaterialName)
  if (!bulkKey) return undefined
  return types.find((type) => materialKey(type.name.split(/\s+bulk\s+to\s+/i, 1)[0] ?? '') === bulkKey)
}
