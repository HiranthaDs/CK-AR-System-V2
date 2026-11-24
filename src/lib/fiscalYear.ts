const MIN_FISCAL_YEAR = 2000
const MAX_FISCAL_YEAR = 2200

function supportedYear(year: number) {
  return Number.isInteger(year) && year >= MIN_FISCAL_YEAR && year <= MAX_FISCAL_YEAR
}

export function currentFiscalYear() {
  return new Date().getFullYear()
}

export function fiscalYearOptions(selectedYear: number, currentYear = currentFiscalYear()) {
  const anchor = supportedYear(currentYear) ? currentYear : currentFiscalYear()
  const years = new Set<number>()
  for (let year = Math.min(MAX_FISCAL_YEAR, anchor + 5); year >= Math.max(MIN_FISCAL_YEAR, anchor - 5); year -= 1)
    years.add(year)
  if (supportedYear(selectedYear)) years.add(selectedYear)
  return [...years].sort((left, right) => right - left)
}

export function dateForFiscalYear(year: number, currentDate: string) {
  if (!supportedYear(year)) throw new RangeError('Fiscal year must be between 2000 and 2200')
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(currentDate)
  if (!match) return `${year}-01-01`
  const month = Number(match[2])
  const day = Number(match[3])
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${match[2]}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}

export function monthForFiscalYear(year: number, currentMonth: string) {
  if (!supportedYear(year)) throw new RangeError('Fiscal year must be between 2000 and 2200')
  const match = /^\d{4}-(0[1-9]|1[0-2])$/.exec(currentMonth)
  return `${year}-${match?.[1] ?? '01'}`
}
