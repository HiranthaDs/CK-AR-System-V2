# Website Catalog API

This is the recommended integration for public and partner websites. It is hosted by Supabase, reads the same live catalogue maintained in CK SYS, and works from browser JavaScript without a separate website backend.

## Create the link

1. Sign in to CK SYS as a company administrator.
2. Open **Settings**.
3. At the bottom, find **Future & partner websites · Live Catalog API**.
4. Select **Enable website API**.
5. Copy the **Public website data URL** or the generated JavaScript example.

The URL has this form:

```text
https://PROJECT.supabase.co/functions/v1/website-catalog?catalog_id=CATALOG_ID
```

The catalog ID is already inside the link. Do not send an API key, Authorization header, or Supabase key.

## Plain HTML / JavaScript

```html
<div id="products"></div>
<script>
  const CATALOG_URL = 'PASTE_THE_PUBLIC_WEBSITE_DATA_URL_HERE'

  async function loadCatalog() {
    const response = await fetch(CATALOG_URL)
    if (!response.ok) throw new Error('Catalog unavailable')
    const catalog = await response.json()

    const cards = catalog.items.map((product) => {
      const card = document.createElement('article')
      const title = document.createElement('h2')
      const description = document.createElement('p')
      const price = document.createElement('strong')
      title.textContent = product.name
      description.textContent = product.description || ''
      price.textContent = `LKR ${Number(product.selling_price).toFixed(2)}`
      if (product.image_url) {
        const image = document.createElement('img')
        image.src = product.image_url
        image.alt = product.name
        image.loading = 'lazy'
        card.append(image)
      }
      card.append(title, description, price)
      return card
    })
    document.querySelector('#products').replaceChildren(...cards)
  }

  loadCatalog().catch(console.error)
</script>
```

The example uses DOM text nodes instead of `innerHTML`, so product text cannot inject markup. Frameworks such as React also escape text values by default.

## React

```tsx
import { useEffect, useState } from 'react'

const CATALOG_URL = 'PASTE_THE_PUBLIC_WEBSITE_DATA_URL_HERE'

export function Products() {
  const [catalog, setCatalog] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(CATALOG_URL)
      .then((response) => {
        if (!response.ok) throw new Error('Catalog unavailable')
        return response.json()
      })
      .then(setCatalog)
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Catalog unavailable'))
  }, [])

  if (error) return <p>{error}</p>
  if (!catalog) return <p>Loading products…</p>

  return catalog.items.map((product) => (
    <article key={product.id}>
      {product.image_url ? <img src={product.image_url} alt={product.name} loading="lazy" /> : null}
      <h2>{product.name}</h2>
      <p>{product.description}</p>
      <strong>LKR {Number(product.selling_price).toFixed(2)}</strong>
    </article>
  ))
}
```

## Response contract

```json
{
  "api_version": "1.0",
  "catalog_id": "40000000-0000-4000-8000-000000000004",
  "generated_at": "2026-11-19T12:00:00.000Z",
  "company": {
    "code": "CK",
    "name": "CK Plastics",
    "address": "…",
    "phone": "…",
    "email": "…",
    "logo_url": "https://…"
  },
  "items": [
    {
      "id": "…",
      "sku": "…",
      "name": "Frame Stand",
      "category": "Frame Stand",
      "image_url": "https://…",
      "selling_price": 1200.00,
      "description": "Short product description",
      "unit": "piece",
      "updated_at": "2026-11-19T12:00:00.000Z"
    }
  ]
}
```

Only active finished products with a positive selling price are returned. Product edits, images, descriptions, prices, and newly added products appear through the same URL automatically.

## Security and lifecycle

- The link is intentionally public and read-only. Anyone with it can read the published company contact details and catalogue.
- It cannot read private ERP tables or write to the database.
- **Regenerate public link** invalidates the old URL and creates a replacement.
- **Disable website API** makes the current URL return `404` immediately.
- Never place `SUPABASE_SECRET_KEY` or any service-role key in a website, repository, or browser environment.
