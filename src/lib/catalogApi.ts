const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function buildWebsiteCatalogUrl(projectUrl: string, catalogId: string) {
  const normalizedProjectUrl = projectUrl.trim().replace(/\/$/, '')
  const normalizedCatalogId = catalogId.trim()
  if (!/^https:\/\/[^/?#]+$/i.test(normalizedProjectUrl) || !UUID_PATTERN.test(normalizedCatalogId)) return ''
  return `${normalizedProjectUrl}/functions/v1/website-catalog?catalog_id=${encodeURIComponent(normalizedCatalogId)}`
}

export function buildWebsiteCatalogSnippet(url: string) {
  if (!url) return ''
  return `const response = await fetch(${JSON.stringify(url)});\nif (!response.ok) throw new Error('Catalog unavailable');\nconst catalog = await response.json();\n// catalog.company and catalog.items are now ready to render`
}
