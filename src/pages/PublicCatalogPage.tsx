import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckCircle2, ChevronRight, Minus, PackageOpen, Plus, ShoppingBag, Sparkles, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'
import { z } from 'zod'
import { Button, EmptyState, ErrorState, Field, Input, LoadingState, Textarea } from '../components/UI'
import { makeRequestId, publicApi } from '../lib/api'
import { money, numberValue } from '../lib/format'
import type { PublicCatalogItem, PublicOrderReceipt } from '../types/api'

const orderSchema = z.object({
  customer_name: z.string().min(2, 'Enter your name.').max(160),
  customer_phone: z.string().min(7, 'Enter a valid phone number.').max(40),
  customer_email: z.string().email('Enter a valid email address.').or(z.literal('')),
  customer_address: z.string().max(500),
  notes: z.string().max(2000),
  website: z.string().max(200),
})
type OrderValues = z.infer<typeof orderSchema>

interface CatalogResponse { items: PublicCatalogItem[] }
type Cart = Record<string, number>

export function PublicCatalogPage() {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [cart, setCart] = useState<Cart>({})
  const [receipt, setReceipt] = useState<PublicOrderReceipt | null>(null)
  const [requestKey, setRequestKey] = useState(() => makeRequestId())
  const form = useForm<OrderValues>({
    resolver: zodResolver(orderSchema),
    defaultValues: { customer_name: '', customer_phone: '', customer_email: '', customer_address: '', notes: '', website: '' },
  })
  const catalogQuery = useQuery({
    queryKey: ['public-catalog'],
    queryFn: ({ signal }) => publicApi.get<CatalogResponse>('/public/catalog', undefined, signal),
    staleTime: 60_000,
  })
  const products = catalogQuery.data?.items ?? []
  const categories = useMemo(() => ['All', ...new Set(products.map((product) => product.category))], [products])
  const visible = products.filter((product) => {
    const term = search.trim().toLowerCase()
    return (category === 'All' || product.category === category)
      && (!term || `${product.name} ${product.category} ${product.description ?? ''}`.toLowerCase().includes(term))
  })
  const cartLines = products
    .filter((product) => (cart[product.id] ?? 0) > 0)
    .map((product) => ({ product, quantity: cart[product.id] ?? 0 }))
  const itemCount = cartLines.reduce((sum, line) => sum + line.quantity, 0)
  const total = cartLines.reduce((sum, line) => sum + line.quantity * numberValue(line.product.selling_price), 0)

  const updateQuantity = (productId: string, quantity: number) => {
    setReceipt(null)
    setCart((current) => {
      const next = { ...current }
      if (quantity <= 0) delete next[productId]
      else next[productId] = Math.min(10000, quantity)
      return next
    })
  }

  const orderMutation = useMutation({
    mutationFn: (values: OrderValues) => publicApi.post<PublicOrderReceipt, Record<string, unknown>>('/public/orders', {
      ...values,
      customer_email: values.customer_email || undefined,
      customer_address: values.customer_address || undefined,
      notes: values.notes || undefined,
      items: cartLines.map((line) => ({ item_id: line.product.id, quantity: line.quantity })),
    }, requestKey),
    onSuccess: (result) => {
      setReceipt(result)
      setCart({})
      setRequestKey(makeRequestId())
      form.reset()
    },
  })
  const submit = form.handleSubmit((values) => {
    if (cartLines.length) orderMutation.mutate(values)
  })

  return <div className="catalog-page">
    <header className="catalog-header">
      <Link to="/catalog" className="catalog-brand"><span>CK</span><div><strong>CK Plastics</strong><small>Product catalogue</small></div></Link>
      <div className="catalog-header__actions"><span><ShoppingBag size={17} /> {itemCount} item{itemCount === 1 ? '' : 's'}</span><Link to="/login">Staff login <ChevronRight size={15} /></Link></div>
    </header>

    <main>
      <section className="catalog-hero">
        <div><span className="catalog-kicker"><Sparkles size={15} /> Browse · Choose · Order</span><h1>Find the right CK Plastics product for your order.</h1><p>View our current product catalogue and send your order request directly to our team. Stock quantities are confirmed after we receive your order.</p></div>
        <div className="catalog-hero__note"><strong>One simple ordering link</strong><span>No account needed. Choose your items, add quantities, and send your contact details.</span></div>
      </section>

      <section className="catalog-layout">
        <div className="catalog-products">
          <div className="catalog-controls">
            <label className="catalog-search"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products" aria-label="Search products" /></label>
            <div className="catalog-categories" aria-label="Product categories">{categories.map((item) => <button type="button" className={category === item ? 'active' : ''} key={item} onClick={() => setCategory(item)}>{item}</button>)}</div>
          </div>
          {catalogQuery.isLoading ? <LoadingState label="Loading products…" /> : catalogQuery.isError ? <ErrorState error={catalogQuery.error} onRetry={() => void catalogQuery.refetch()} /> : visible.length ? <div className="catalog-product-grid">{visible.map((product) => {
            const quantity = cart[product.id] ?? 0
            return <article className="catalog-product-card" key={product.id}>
              <div className="catalog-product-card__image">{product.image_url ? <img src={product.image_url} alt={product.name} loading="lazy" /> : <PackageOpen size={40} aria-hidden="true" />}</div>
              <div className="catalog-product-card__body"><span>{product.category}</span><h2>{product.name}</h2><p>{product.description || 'Contact us for product specifications and available options.'}</p><div className="catalog-product-card__footer"><strong>{money(product.selling_price)}</strong>{quantity ? <div className="quantity-stepper"><button type="button" onClick={() => updateQuantity(product.id, quantity - 1)} aria-label={`Remove one ${product.name}`}><Minus size={15} /></button><span>{quantity}</span><button type="button" onClick={() => updateQuantity(product.id, quantity + 1)} aria-label={`Add one ${product.name}`}><Plus size={15} /></button></div> : <Button size="small" icon={Plus} onClick={() => updateQuantity(product.id, 1)}>Add</Button>}</div></div>
            </article>
          })}</div> : <EmptyState message="No products match this search." />}
        </div>

        <aside className="catalog-cart">
          <div className="catalog-cart__heading"><div><ShoppingBag size={22} /><span><strong>Your order</strong><small>{itemCount ? `${itemCount} item${itemCount === 1 ? '' : 's'} selected` : 'Choose products to begin'}</small></span></div><strong>{money(total)}</strong></div>
          {receipt ? <div className="catalog-order-success"><CheckCircle2 size={42} /><h2>Order received</h2><p>Thank you. Our team will review your request and contact you.</p><div><span>Order reference</span><strong>{receipt.order_no}</strong></div><Button onClick={() => setReceipt(null)}>Place another order</Button></div> : <>
            {cartLines.length ? <div className="catalog-cart__lines">{cartLines.map(({ product, quantity }) => <div className="catalog-cart-line" key={product.id}><div>{product.image_url ? <img src={product.image_url} alt="" /> : <PackageOpen size={18} />}<span><strong>{product.name}</strong><small>{quantity} × {money(product.selling_price)}</small></span></div><button type="button" onClick={() => updateQuantity(product.id, 0)} aria-label={`Remove ${product.name}`}><Trash2 size={16} /></button></div>)}</div> : <div className="catalog-cart__empty"><ShoppingBag size={30} /><span>Your selected products will appear here.</span></div>}
            <form className="catalog-checkout" onSubmit={(event) => void submit(event)}>
              <h2>Contact details</h2>
              <Field label="Name" required error={form.formState.errors.customer_name?.message}><Input {...form.register('customer_name')} autoComplete="name" /></Field>
              <Field label="Phone / WhatsApp" required error={form.formState.errors.customer_phone?.message}><Input {...form.register('customer_phone')} type="tel" autoComplete="tel" /></Field>
              <Field label="Email" error={form.formState.errors.customer_email?.message}><Input {...form.register('customer_email')} type="email" autoComplete="email" /></Field>
              <Field label="Delivery address"><Textarea {...form.register('customer_address')} rows={2} autoComplete="street-address" /></Field>
              <Field label="Order notes"><Textarea {...form.register('notes')} rows={2} placeholder="Colour, size, deadline, or another request" /></Field>
              <label className="catalog-honeypot" aria-hidden="true">Website<Input {...form.register('website')} tabIndex={-1} autoComplete="off" /></label>
              {orderMutation.isError ? <div className="catalog-order-error" role="alert">{orderMutation.error instanceof Error ? orderMutation.error.message : 'Your order could not be sent. Please try again.'}</div> : null}
              <Button type="submit" icon={ShoppingBag} loading={orderMutation.isPending} disabled={!cartLines.length}>Send order · {money(total)}</Button>
              <small>Submitting an order request does not reserve stock. Our team will confirm availability and delivery details.</small>
            </form>
          </>}
        </aside>
      </section>
    </main>
    <footer className="catalog-footer"><strong>CK Plastics</strong><span>Product catalogue and customer ordering</span></footer>
  </div>
}
