import { describe, expect, it } from 'vitest'
import { buildWebsiteCatalogSnippet, buildWebsiteCatalogUrl } from '../lib/catalogApi'

const CATALOG_ID = '40000000-0000-4000-8000-000000000004'

describe('browser-ready website catalog API', () => {
  it('builds one Supabase Edge Function URL without a secret key', () => {
    const url = buildWebsiteCatalogUrl('https://project.supabase.co/', CATALOG_ID)
    expect(url).toBe(`https://project.supabase.co/functions/v1/website-catalog?catalog_id=${CATALOG_ID}`)
    expect(url).not.toContain('key=')
    expect(url).not.toContain('secret')
  })

  it('rejects malformed project URLs and catalog ids', () => {
    expect(buildWebsiteCatalogUrl('http://project.supabase.co', CATALOG_ID)).toBe('')
    expect(buildWebsiteCatalogUrl('https://project.supabase.co', 'not-an-id')).toBe('')
  })

  it('generates a copy-and-paste browser fetch example', () => {
    const url = buildWebsiteCatalogUrl('https://project.supabase.co', CATALOG_ID)
    const snippet = buildWebsiteCatalogSnippet(url)
    expect(snippet).toContain(`fetch("${url}")`)
    expect(snippet).toContain('catalog.company')
    expect(snippet).toContain('catalog.items')
  })
})
