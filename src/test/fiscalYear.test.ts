import { describe, expect, it } from 'vitest'
import { dateForFiscalYear, fiscalYearOptions, monthForFiscalYear } from '../lib/fiscalYear'

describe('fiscal-year date logic', () => {
  it('offers 2026, 2027, and 2028 while the current year is 2026', () => {
    const years = fiscalYearOptions(2026, 2026)
    expect(years).toEqual(expect.arrayContaining([2026, 2027, 2028]))
  })

  it.each([2026, 2027, 2028])('keeps staff dates and months inside %i', (year) => {
    expect(dateForFiscalYear(year, '2026-11-24')).toBe(`${year}-11-24`)
    expect(monthForFiscalYear(year, '2026-11')).toBe(`${year}-11`)
  })

  it('handles leap-day transitions without overflowing into March', () => {
    expect(dateForFiscalYear(2028, '2026-02-28')).toBe('2028-02-28')
    expect(dateForFiscalYear(2027, '2028-02-29')).toBe('2027-02-28')
    expect(dateForFiscalYear(2028, '2028-02-29')).toBe('2028-02-29')
  })

  it('keeps supported years visible even outside the normal rolling window', () => {
    expect(fiscalYearOptions(2050, 2026)).toContain(2050)
  })
})
