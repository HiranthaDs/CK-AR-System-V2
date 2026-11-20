import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFieldArray, useForm } from 'react-hook-form'
import { useEffect, useState } from 'react'
import { Banknote, ClipboardList, Download, ExternalLink, FileBarChart, FileText, MessageCircle, Pencil, Plus, Printer, ReceiptText, RotateCcw, ShoppingCart, Trash2, WalletCards } from 'lucide-react'
import { z } from 'zod/v3'
import { api } from '../lib/api'
import { localIsoDate, money, numberValue, quantity, shortDate, titleCase } from '../lib/format'
import { invoiceWhatsAppMessage, normalizeWhatsAppPhone, saleLineName, suggestedUnitPrice } from '../lib/salesInvoice'
import { downloadQuotationPdf, printQuotationPdf, quotationWhatsAppMessage, shareQuotationPdf } from '../lib/quotationPdf'
import { downloadSalesInvoicePdf, printSalesInvoicePdf, shareSalesInvoicePdf } from '../lib/salesInvoicePdf'
import type { CompanyProfile, CustomerOrder, CustomerOrderStatus, InventoryPosition, MutationReceipt, Page, Payment, Quotation, Sale } from '../types/api'
import { useAppContext } from '../layout/AppShell'
import { useToast } from '../components/Toast'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { RemoteSelect } from '../components/RemoteSelect'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  InlineNotice,
  Input,
  LoadingState,
  PageHeader,
  Pagination,
  SearchBox,
  SectionTitle,
  Select,
  StatCard,
  TableWrap,
  Tabs,
  Textarea,
} from '../components/UI'

type SalesTab = 'orders' | 'invoices' | 'quotations' | 'outstanding' | 'report'

const paymentMethods = ['cash', 'bank_transfer', 'cheque', 'credit', 'accounts_receivable', 'other'] as const
const lineSchema = z.object({
  item_id: z.string().uuid('Select a finished item.'),
  quantity: z.coerce.number().positive('Quantity must be greater than zero.'),
  unit_price: z.coerce.number().positive('Price must be greater than zero.'),
  discount: z.coerce.number().min(0, 'Discount cannot be negative.'),
}).refine((line) => line.discount < line.quantity * line.unit_price, { message: 'Discount must be less than line gross.', path: ['discount'] })

const saleSchema = z.object({
  invoice_no: z.string().max(80).optional(),
  sale_date: z.string().min(1, 'Select a sale date.'),
  customer_name: z.string().min(1, 'Customer name is required.').max(160),
  customer_phone: z.string().max(40),
  payment_method: z.enum(paymentMethods),
  document_status: z.enum(['issued', 'delivered', 'completed']),
  amount_paid: z.coerce.number().min(0),
  items: z.array(lineSchema).min(1, 'Add at least one invoice item.').max(500),
}).refine((sale) => sale.amount_paid <= sale.items.reduce((sum, line) => sum + line.quantity * line.unit_price - line.discount, 0), {
  message: 'Initial payment cannot exceed the invoice total.',
  path: ['amount_paid'],
})

const paymentSchema = z.object({
  payment_date: z.string().min(1, 'Select a payment date.'),
  amount: z.coerce.number().positive('Amount must be greater than zero.'),
  method: z.enum(paymentMethods),
  notes: z.string().max(1000),
})

const quotationLineSchema = z.object({
  manual: z.boolean(),
  item_id: z.string().optional(),
  product_name: z.string().trim().max(160),
  product_type: z.string().trim().max(100),
  quantity: z.coerce.number().positive('Quantity must be greater than zero.'),
  unit_price: z.coerce.number().positive('Price must be greater than zero.'),
  discount: z.coerce.number().min(0, 'Discount cannot be negative.'),
}).superRefine((line, context) => {
  if (line.manual && !line.product_name) context.addIssue({ code: 'custom', message: 'Manual product name is required.', path: ['product_name'] })
  if (!line.manual && !z.string().uuid().safeParse(line.item_id).success) context.addIssue({ code: 'custom', message: 'Select a finished product.', path: ['item_id'] })
  if (line.discount >= line.quantity * line.unit_price) context.addIssue({ code: 'custom', message: 'Discount must be less than line gross.', path: ['discount'] })
})

const quotationSchema = z.object({
  quotation_no: z.string().max(80).optional(),
  quotation_date: z.string().min(1, 'Select a quotation date.'),
  valid_until: z.string().min(1, 'Select a validity date.'),
  customer_name: z.string().min(1, 'Customer name is required.').max(160),
  customer_phone: z.string().max(40),
  customer_email: z.string().email('Enter a valid email address.').max(254).or(z.literal('')),
  customer_address: z.string().max(500),
  payment_method: z.enum(paymentMethods),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired']),
  terms: z.string().max(4000),
  notes: z.string().max(4000),
  items: z.array(quotationLineSchema).min(1, 'Add at least one quotation item.').max(100),
}).refine((quotation) => quotation.valid_until >= quotation.quotation_date, { message: 'Valid until cannot be before the quotation date.', path: ['valid_until'] })

type SaleValues = z.infer<typeof saleSchema>
type PaymentValues = z.infer<typeof paymentSchema>
type QuotationValues = z.infer<typeof quotationSchema>
const pageSize = 30

function dateAfter(days: number) {
  const value = new Date()
  value.setDate(value.getDate() + days)
  const offset = value.getTimezoneOffset()
  return new Date(value.getTime() - offset * 60_000).toISOString().slice(0, 10)
}

function saleLines(sale: Sale) {
  return sale.sale_items ?? []
}

function salePayments(sale: Sale) {
  return sale.sale_payments ?? []
}

function statusTone(status: string | null | undefined) {
  if (status === 'paid' || status === 'posted') return 'success' as const
  if (status === 'partial') return 'warning' as const
  if (status === 'reversed') return 'danger' as const
  return 'neutral' as const
}

export function SalesPage() {
  const { year } = useAppContext()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<SalesTab>('invoices')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [saleOpen, setSaleOpen] = useState(false)
  const [editingSale, setEditingSale] = useState<Sale | null>(null)
  const [invoiceActionId, setInvoiceActionId] = useState<string | null>(null)
  const [quotationOpen, setQuotationOpen] = useState(false)
  const [editingQuotation, setEditingQuotation] = useState<Quotation | null>(null)
  const [quotationActionId, setQuotationActionId] = useState<string | null>(null)
  const [cancelQuotation, setCancelQuotation] = useState<Quotation | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<CustomerOrder | null>(null)
  const [paymentSale, setPaymentSale] = useState<Sale | null>(null)
  const [reverseSale, setReverseSale] = useState<Sale | null>(null)
  const [reversePayment, setReversePayment] = useState<{ sale: Sale; payment: Payment } | null>(null)

  const dateQuery = { from_date: `${year}-01-01`, to_date: `${year}-12-31` }
  const salesQuery = useQuery({
    queryKey: ['sales', year, page, search],
    queryFn: ({ signal }) => api.list<Sale>('/sales', { ...dateQuery, page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'invoices',
  })
  const outstandingQuery = useQuery({
    queryKey: ['sales-outstanding', year, page, search],
    queryFn: ({ signal }) => api.list<Sale>('/sales-outstanding', { ...dateQuery, page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'outstanding',
  })
  const reportQuery = useQuery({
    queryKey: ['report', 'sales', year, page, search],
    queryFn: ({ signal }) => api.list<Sale>('/reports/sales', { ...dateQuery, page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'report',
  })
  const quotationsQuery = useQuery({
    queryKey: ['quotations', year, page, search],
    queryFn: ({ signal }) => api.list<Quotation>('/quotations', { ...dateQuery, page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'quotations',
  })
  const ordersQuery = useQuery({
    queryKey: ['customer-orders', year, page, search],
    queryFn: ({ signal }) => api.list<CustomerOrder>('/customer-orders', { ...dateQuery, page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'orders',
  })

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['sales'] }),
      queryClient.invalidateQueries({ queryKey: ['quotations'] }),
      queryClient.invalidateQueries({ queryKey: ['customer-orders'] }),
      queryClient.invalidateQueries({ queryKey: ['sales-outstanding'] }),
      queryClient.invalidateQueries({ queryKey: ['report', 'sales'] }),
      queryClient.invalidateQueries({ queryKey: ['inventory'] }),
      queryClient.invalidateQueries({ queryKey: ['lookup'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['ledger'] }),
    ])
  }

  const editSaleMutation = useMutation({
    mutationFn: (saleId: string) => api.get<Sale>(`/sales/${saleId}`),
    onSuccess: (sale) => {
      setEditingSale(sale)
      setSaleOpen(true)
    },
    onError: (error) => toast.error('Invoice could not be opened', error instanceof Error ? error.message : 'Try again.'),
  })

  const saleMutation = useMutation({
    mutationFn: ({ id, body }: { id?: string | undefined; body: SaleValues }) => id
      ? api.patch<MutationReceipt, SaleValues>(`/sales/${id}`, body)
      : api.post<MutationReceipt, SaleValues>('/sales', body),
    onSuccess: async (receipt) => {
      setSaleOpen(false)
      setEditingSale(null)
      setTab('invoices')
      setPage(1)
      if (receipt.id) setInvoiceActionId(receipt.id)
      await invalidate()
      toast.success('Invoice saved', 'Review the invoice, print it, or send it to the customer on WhatsApp.')
    },
    onError: (error) => toast.error('Invoice was not saved', error instanceof Error ? error.message : 'Try again.'),
  })
  const paymentMutation = useMutation({
    mutationFn: ({ saleId, body }: { saleId: string; body: PaymentValues }) => api.post<MutationReceipt, PaymentValues>(`/sales/${saleId}/payments`, body),
    onSuccess: async () => {
      setPaymentSale(null)
      await invalidate()
      toast.success('Receipt posted', 'The invoice balance and accounting ledger are current.')
    },
    onError: (error) => toast.error('Receipt was not posted', error instanceof Error ? error.message : 'Try again.'),
  })
  const editQuotationMutation = useMutation({
    mutationFn: (quotationId: string) => api.get<Quotation>(`/quotations/${quotationId}`),
    onSuccess: (quotation) => { setEditingQuotation(quotation); setQuotationOpen(true) },
    onError: (error) => toast.error('Quotation could not be opened', error instanceof Error ? error.message : 'Try again.'),
  })
  const quotationMutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: QuotationValues }) => id
      ? api.patch<MutationReceipt, QuotationValues>(`/quotations/${id}`, body)
      : api.post<MutationReceipt, QuotationValues>('/quotations', body),
    onSuccess: async (receipt) => {
      setQuotationOpen(false)
      setEditingQuotation(null)
      setTab('quotations')
      setPage(1)
      if (receipt.id) setQuotationActionId(receipt.id)
      await invalidate()
      toast.success('Quotation saved', 'The customer-ready PDF is ready to preview, download, or share.')
    },
    onError: (error) => toast.error('Quotation was not saved', error instanceof Error ? error.message : 'Try again.'),
  })
  const cancelQuotationMutation = useMutation({
    mutationFn: (quotation: Quotation) => api.delete<MutationReceipt, { reason: string }>(`/quotations/${quotation.id}`, { reason: 'Cancelled from sales workspace' }),
    onSuccess: async () => { setCancelQuotation(null); await invalidate(); toast.success('Quotation cancelled', 'It remains available in the quotation history.') },
    onError: (error) => toast.error('Unable to cancel quotation', error instanceof Error ? error.message : 'Try again.'),
  })
  const orderStatusMutation = useMutation({
    mutationFn: ({ order, status }: { order: CustomerOrder; status: CustomerOrderStatus }) => api.patch<MutationReceipt, { status: CustomerOrderStatus }>(`/customer-orders/${order.id}/status`, { status }),
    onSuccess: async (_, variables) => {
      setSelectedOrder((current) => current && current.id === variables.order.id ? { ...current, status: variables.status } : current)
      await queryClient.invalidateQueries({ queryKey: ['customer-orders'] })
      toast.success('Order status updated', `${variables.order.order_no} is now ${titleCase(variables.status)}.`)
    },
    onError: (error) => toast.error('Order status was not updated', error instanceof Error ? error.message : 'Try again.'),
  })
  const reverseSaleMutation = useMutation({
    mutationFn: (sale: Sale) => api.delete<MutationReceipt, { reason: string }>(`/sales/${sale.id}`, { reason: 'Reversed from sales workspace' }),
    onSuccess: async () => { setReverseSale(null); await invalidate(); toast.success('Invoice reversed', 'All stock and accounting effects were offset.') },
    onError: (error) => toast.error('Unable to reverse invoice', error instanceof Error ? error.message : 'Try again.'),
  })
  const reversePaymentMutation = useMutation({
    mutationFn: ({ sale, payment }: { sale: Sale; payment: Payment }) => api.delete<MutationReceipt, { reason: string }>(`/sales/${sale.id}/payments/${payment.id}`, { reason: 'Receipt reversed from sales workspace' }),
    onSuccess: async () => { setReversePayment(null); setPaymentSale(null); await invalidate(); toast.success('Receipt reversed', 'The invoice balance was restored.') },
    onError: (error) => toast.error('Unable to reverse receipt', error instanceof Error ? error.message : 'Try again.'),
  })

  const pageData = tab === 'outstanding' ? outstandingQuery.data : tab === 'report' ? reportQuery.data : tab === 'quotations' || tab === 'orders' ? undefined : salesQuery.data
  const visibleRows = pageData?.items ?? []
  const visibleRevenue = visibleRows.reduce((sum, sale) => sum + numberValue(sale.total_amount), 0)
  const visiblePaid = visibleRows.reduce((sum, sale) => sum + numberValue(sale.paid_amount), 0)
  const visibleDue = visibleRows.reduce((sum, sale) => sum + numberValue(sale.balance_due), 0)
  const changeTab = (value: SalesTab) => { setTab(value); setPage(1); setSearch('') }

  return (
    <div className="page-stack">
      <PageHeader eyebrow={`${year} sales`} title="Sales & receivables" description="Receive customer orders, create quotations and invoices, settle balances, and inspect receivables." actions={<div className="row-actions"><Button variant="secondary" icon={ExternalLink} onClick={() => window.open('/catalog', '_blank', 'noopener,noreferrer')}>Customer catalogue</Button><Button variant="secondary" icon={FileText} onClick={() => { setEditingQuotation(null); setQuotationOpen(true) }}>New quotation</Button><Button icon={Plus} onClick={() => { setEditingSale(null); setSaleOpen(true) }}>New invoice</Button></div>} />
      {tab !== 'quotations' && tab !== 'orders' ? <div className="stats-grid stats-grid--four">
        <StatCard label="Visible invoices" value={pageData?.total ?? 0} icon={ReceiptText} tone="blue" />
        <StatCard label="Visible sales" value={money(visibleRevenue)} icon={ShoppingCart} tone="green" />
        <StatCard label="Visible receipts" value={money(visiblePaid)} icon={Banknote} tone="purple" />
        <StatCard label="Visible balance" value={money(visibleDue)} icon={WalletCards} tone="amber" />
      </div> : null}
      <Tabs value={tab} onChange={changeTab} ariaLabel="Sales sections" items={[
        { value: 'orders', label: 'Orders', icon: ClipboardList },
        { value: 'invoices', label: 'Invoices', icon: ReceiptText },
        { value: 'quotations', label: 'Quotations', icon: FileText },
        { value: 'outstanding', label: 'Outstanding', icon: WalletCards },
        { value: 'report', label: 'Sales report', icon: FileBarChart },
      ]} />

      {tab === 'orders' ? <CustomerOrdersList query={ordersQuery} page={page} setPage={setPage} search={search} setSearch={setSearch} onOpen={setSelectedOrder} /> : tab === 'quotations' ? <QuotationList query={quotationsQuery} page={page} setPage={setPage} search={search} setSearch={setSearch} editingId={editQuotationMutation.isPending ? editQuotationMutation.variables : undefined} onAdd={() => { setEditingQuotation(null); setQuotationOpen(true) }} onPreview={(quotation) => setQuotationActionId(quotation.id)} onEdit={(quotation) => editQuotationMutation.mutate(quotation.id)} onCancel={setCancelQuotation} /> : <Card className={tab === 'report' ? 'print-area' : undefined}>
        <SectionTitle
          title={tab === 'outstanding' ? 'Outstanding invoices' : tab === 'report' ? 'Sales report' : 'Posted invoices'}
          description="Search is executed by the API and results remain server-paginated."
          actions={tab === 'report' ? <Button variant="secondary" onClick={() => window.print()}>Print / save PDF</Button> : <Button icon={Plus} onClick={() => { setEditingSale(null); setSaleOpen(true) }}>New invoice</Button>}
        />
        <div className="toolbar no-print"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search invoice number" /></div>
        <SalesTable
          query={tab === 'outstanding' ? outstandingQuery : tab === 'report' ? reportQuery : salesQuery}
          page={page}
          setPage={setPage}
          editingSaleId={editSaleMutation.isPending ? editSaleMutation.variables : undefined}
          onInvoice={(sale) => setInvoiceActionId(sale.id)}
          onEdit={(sale) => editSaleMutation.mutate(sale.id)}
          onPayment={setPaymentSale}
          onReverse={setReverseSale}
        />
      </Card>}

      <SaleDialog open={saleOpen} record={editingSale} mutation={saleMutation} onClose={() => { setSaleOpen(false); setEditingSale(null) }} />
      <QuotationDialog open={quotationOpen} record={editingQuotation} mutation={quotationMutation} onClose={() => { setQuotationOpen(false); setEditingQuotation(null) }} />
      <QuotationActionsDialog quotationId={quotationActionId} onClose={() => setQuotationActionId(null)} />
      <InvoiceActionsDialog saleId={invoiceActionId} onClose={() => setInvoiceActionId(null)} />
      <PaymentDialog sale={paymentSale} mutation={paymentMutation} onReverse={(payment) => { if (paymentSale) setReversePayment({ sale: paymentSale, payment }) }} onClose={() => setPaymentSale(null)} />
      <CustomerOrderDialog key={selectedOrder?.id ?? 'closed-order'} order={selectedOrder} mutation={orderStatusMutation} onClose={() => setSelectedOrder(null)} />
      <ConfirmDialog open={Boolean(reverseSale)} title="Reverse this invoice?" message={`${reverseSale?.invoice_no ?? 'This invoice'} will remain in the audit trail. Stock, revenue, COGS, and receipts will be offset atomically.`} destructive confirmLabel="Post reversal" busy={reverseSaleMutation.isPending} onCancel={() => setReverseSale(null)} onConfirm={() => { if (reverseSale) reverseSaleMutation.mutate(reverseSale) }} />
      <ConfirmDialog open={Boolean(reversePayment)} title="Reverse this receipt?" message={`${reversePayment?.payment.reference_no ?? 'This receipt'} will remain visible and its accounting effect will be offset.`} destructive confirmLabel="Reverse receipt" busy={reversePaymentMutation.isPending} onCancel={() => setReversePayment(null)} onConfirm={() => { if (reversePayment) reversePaymentMutation.mutate(reversePayment) }} />
      <ConfirmDialog open={Boolean(cancelQuotation)} title="Cancel this quotation?" message={`${cancelQuotation?.quotation_no ?? 'This quotation'} will remain visible in quotation history and can no longer be edited.`} destructive confirmLabel="Cancel quotation" busy={cancelQuotationMutation.isPending} onCancel={() => setCancelQuotation(null)} onConfirm={() => { if (cancelQuotation) cancelQuotationMutation.mutate(cancelQuotation) }} />
    </div>
  )
}

const customerOrderStatuses: CustomerOrderStatus[] = ['pending', 'confirmed', 'in_progress', 'ready', 'completed', 'cancelled']

function orderStatusTone(status: CustomerOrderStatus) {
  if (status === 'completed') return 'success' as const
  if (status === 'cancelled') return 'danger' as const
  if (status === 'confirmed' || status === 'ready') return 'info' as const
  if (status === 'in_progress') return 'warning' as const
  return 'neutral' as const
}

function CustomerOrdersList({ query, page, setPage, search, setSearch, onOpen }: {
  query: ReturnType<typeof useQuery<Page<CustomerOrder>>>
  page: number
  setPage: (page: number) => void
  search: string
  setSearch: (value: string) => void
  onOpen: (order: CustomerOrder) => void
}) {
  const rows = query.data?.items ?? []
  return <Card>
    <SectionTitle title="Customer orders" description="Orders submitted from the shareable catalogue appear here immediately. Product prices are snapshotted when the customer sends the order." actions={<Button variant="secondary" icon={ExternalLink} onClick={() => window.open('/catalog', '_blank', 'noopener,noreferrer')}>Open customer catalogue</Button>} />
    <InlineNotice tone="success" title="No stock information is shared">Customers see active product details and selling prices only. Confirm availability before moving an order to Confirmed.</InlineNotice>
    <div className="toolbar"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search customer name" /></div>
    {query.isLoading ? <LoadingState label="Loading customer orders…" /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? <>
      <TableWrap><table><thead><tr><th>Order / received</th><th>Customer</th><th className="numeric">Items</th><th className="numeric">Total</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((order) => <tr key={order.id}>
        <td><strong className="mono">{order.order_no}</strong><span className="table-subtext">{shortDate(order.created_at)}</span></td>
        <td><strong>{order.customer_name}</strong><span className="table-subtext">{order.customer_phone}{order.customer_email ? ` · ${order.customer_email}` : ''}</span></td>
        <td className="numeric">{order.customer_order_items?.length ?? 0}</td>
        <td className="numeric"><strong>{money(order.total_amount)}</strong></td>
        <td><Badge tone={orderStatusTone(order.status)}>{titleCase(order.status)}</Badge></td>
        <td><Button size="small" variant="ghost" icon={ClipboardList} onClick={() => onOpen(order)}>Review</Button></td>
      </tr>)}</tbody></table></TableWrap>
      <Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} />
    </> : <EmptyState message="No customer orders match this period and search." />}
  </Card>
}

function CustomerOrderDialog({ order, mutation, onClose }: {
  order: CustomerOrder | null
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { order: CustomerOrder; status: CustomerOrderStatus }>>
  onClose: () => void
}) {
  const [status, setStatus] = useState<CustomerOrderStatus>(order?.status ?? 'pending')
  const lines = order?.customer_order_items ?? []
  return <Dialog open={Boolean(order)} title={order ? `Order ${order.order_no}` : 'Customer order'} description="Review the request, confirm availability with the customer, and keep the status current." size="wide" onClose={onClose} closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button icon={ClipboardList} loading={mutation.isPending} disabled={!order || status === order.status} onClick={() => { if (order) mutation.mutate({ order, status }) }}>Update status</Button></>}>
    {order ? <div className="order-review">
      <div className="order-review__summary">
        <section><span>Customer</span><strong>{order.customer_name}</strong><small>{order.customer_phone}</small><small>{order.customer_email || 'No email provided'}</small></section>
        <section><span>Delivery address</span><strong>{order.customer_address || 'Not provided'}</strong><small>{order.notes || 'No order notes'}</small></section>
        <Field label="Order status"><Select value={status} onChange={(event) => setStatus(event.target.value as CustomerOrderStatus)}>{customerOrderStatuses.map((value) => <option value={value} key={value}>{titleCase(value)}</option>)}</Select></Field>
      </div>
      <TableWrap><table><thead><tr><th>Product</th><th>Category</th><th className="numeric">Quantity</th><th className="numeric">Unit price</th><th className="numeric">Amount</th></tr></thead><tbody>{lines.map((line) => <tr key={line.id}><td><div className="order-product-cell">{line.product_image_url ? <img src={line.product_image_url} alt="" /> : null}<span><strong>{line.product_name}</strong><small>{line.product_description || 'No description'}</small></span></div></td><td>{line.product_category}</td><td className="numeric">{quantity(line.quantity)}</td><td className="numeric">{money(line.unit_price)}</td><td className="numeric"><strong>{money(line.line_total)}</strong></td></tr>)}</tbody></table></TableWrap>
      <div className="form-total"><span>Order total</span><strong>{money(order.total_amount)}</strong></div>
    </div> : null}
  </Dialog>
}

function QuotationList({ query, page, setPage, search, setSearch, editingId, onAdd, onPreview, onEdit, onCancel }: {
  query: ReturnType<typeof useQuery<Page<Quotation>>>
  page: number
  setPage: (page: number) => void
  search: string
  setSearch: (value: string) => void
  editingId: string | undefined
  onAdd: () => void
  onPreview: (quotation: Quotation) => void
  onEdit: (quotation: Quotation) => void
  onCancel: (quotation: Quotation) => void
}) {
  const rows = query.data?.items ?? []
  return <Card>
    <SectionTitle title="Posted quotations" description="Build reusable product quotations without reducing stock or posting accounting entries." actions={<Button icon={Plus} onClick={onAdd}>New quotation</Button>} />
    <div className="toolbar"><SearchBox value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search quotation number" /></div>
    {query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? <>
      <TableWrap><table><thead><tr><th>Date / quotation</th><th>Customer</th><th>Valid until</th><th className="numeric">Items</th><th className="numeric">Total</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((quotation) => <tr key={quotation.id}>
        <td><strong className="mono">{quotation.quotation_no}</strong><span className="table-subtext">{shortDate(quotation.quotation_date)} · {quotation.reference_no}</span></td>
        <td><strong>{quotation.customer_name}</strong><span className="table-subtext">{quotation.customer_phone || quotation.customer_email || 'No contact details'}</span></td>
        <td>{shortDate(quotation.valid_until)}</td>
        <td className="numeric">{quotation.quotation_items?.length ?? 0}</td>
        <td className="numeric"><strong>{money(quotation.total_amount)}</strong></td>
        <td><Badge tone={quotation.status === 'accepted' ? 'success' : quotation.status === 'rejected' || quotation.status === 'cancelled' || quotation.status === 'expired' ? 'danger' : quotation.status === 'sent' ? 'warning' : 'neutral'}>{titleCase(quotation.status)}</Badge></td>
        <td><div className="row-actions"><Button size="small" variant="ghost" icon={FileText} onClick={() => onPreview(quotation)}>PDF</Button><Button size="small" variant="ghost" icon={Pencil} loading={editingId === quotation.id} disabled={quotation.status === 'cancelled' || Boolean(editingId && editingId !== quotation.id)} onClick={() => onEdit(quotation)}>Edit</Button><Button size="small" variant="ghost" icon={RotateCcw} disabled={quotation.status === 'cancelled'} onClick={() => onCancel(quotation)}>Cancel</Button></div></td>
      </tr>)}</tbody></table></TableWrap>
      <Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} />
    </> : <EmptyState message="No quotations match the selected period and search." action={<Button icon={Plus} onClick={onAdd}>Create first quotation</Button>} />}
  </Card>
}

function QuotationDialog({ open, record, mutation, onClose }: {
  open: boolean
  record: Quotation | null
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { id?: string; body: QuotationValues }>>
  onClose: () => void
}) {
  const [selectedItems, setSelectedItems] = useState<Record<string, InventoryPosition>>({})
  const form = useForm<QuotationValues>({
    resolver: zodResolver(quotationSchema),
    values: {
      quotation_no: record?.quotation_no ?? '',
      quotation_date: record?.quotation_date ?? localIsoDate(),
      valid_until: record?.valid_until ?? dateAfter(14),
      customer_name: record?.customer_name ?? '',
      customer_phone: record?.customer_phone ?? '',
      customer_email: record?.customer_email ?? '',
      customer_address: record?.customer_address ?? '',
      payment_method: paymentMethods.includes(record?.payment_method as typeof paymentMethods[number]) ? record?.payment_method as typeof paymentMethods[number] : 'accounts_receivable',
      status: record && record.status !== 'cancelled' ? record.status : 'draft',
      terms: record?.terms ?? 'Prices are valid until the date shown. Delivery timing and payment terms are subject to confirmation.',
      notes: record?.notes ?? '',
      items: (record?.quotation_items ?? []).map((line) => ({ manual: !line.item_id, item_id: line.item_id ?? '', product_name: line.product_name, product_type: line.product_type ?? '', quantity: numberValue(line.quantity), unit_price: numberValue(line.unit_price), discount: numberValue(line.discount) })).concat(record ? [] : [{ manual: false, item_id: '', product_name: '', product_type: '', quantity: 1, unit_price: 0, discount: 0 }]),
    },
  })
  const fields = useFieldArray({ control: form.control, name: 'items' })
  const items = form.watch('items')
  const total = items.reduce((sum, line) => sum + numberValue(line.quantity) * numberValue(line.unit_price) - numberValue(line.discount), 0)
  const submit = form.handleSubmit((body) => mutation.mutate({
    ...(record ? { id: record.id } : {}),
    body: {
      ...body,
      quotation_no: record?.quotation_no,
      items: body.items.map((line) => line.manual
        ? { ...line, item_id: undefined }
        : { ...line, product_name: '', product_type: '' }),
    },
  }))

  useEffect(() => setSelectedItems({}), [open, record?.id])

  return <Dialog open={open} title={record ? 'Edit quotation' : 'New quotation'} description="Select a produced item or enter a manual item. Prices, discounts, and totals recalculate immediately." size="wide" onClose={onClose} closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={FileText} loading={mutation.isPending} onClick={() => void submit()}>Save quotation</Button></>}>
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <div className="form-grid form-grid--three">
        <Field label="Quotation No." hint="Generated automatically when saved."><Input value={record?.quotation_no ?? 'Automatic · QT-CKP-0001'} readOnly aria-label="Quotation No." /></Field>
        <Field label="Quotation date" required error={form.formState.errors.quotation_date?.message}><Input type="date" {...form.register('quotation_date')} /></Field>
        <Field label="Valid until" required error={form.formState.errors.valid_until?.message}><Input type="date" {...form.register('valid_until')} /></Field>
        <Field label="Customer name" required error={form.formState.errors.customer_name?.message}><Input {...form.register('customer_name')} /></Field>
        <Field label="Customer phone"><Input type="tel" {...form.register('customer_phone')} /></Field>
        <Field label="Customer email" error={form.formState.errors.customer_email?.message}><Input type="email" {...form.register('customer_email')} /></Field>
        <Field label="Customer address" className="field--span-2"><Textarea rows={2} {...form.register('customer_address')} /></Field>
        <Field label="Payment method" required><Select {...form.register('payment_method')}>{paymentMethods.map((method) => <option value={method} key={method}>{titleCase(method)}</option>)}</Select></Field>
        <Field label="Status"><Select {...form.register('status')}><option value="draft">Draft</option><option value="sent">Sent</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option><option value="expired">Expired</option></Select></Field>
      </div>
      <SectionTitle title="Quotation items" description="Choose products received from production or enter details manually. Saved selling prices are auto-filled and remain editable." actions={<Button type="button" size="small" variant="secondary" icon={Plus} onClick={() => fields.append({ manual: false, item_id: '', product_name: '', product_type: '', quantity: 1, unit_price: 0, discount: 0 })}>Add item</Button>} />
      <div className="line-card-list">{fields.fields.map((field, index) => {
        const line = items[index]
        const selected = selectedItems[field.id]
        const savedLine = record?.quotation_items[index]
        const lineTotal = numberValue(line?.quantity) * numberValue(line?.unit_price) - numberValue(line?.discount)
        return <Card className="line-card line-card--quotation" key={field.id}>
          <Field label="Product source" required><Select value={line?.manual ? 'manual' : 'catalog'} onChange={(event) => {
            const manual = event.target.value === 'manual'
            form.setValue(`items.${index}.manual`, manual, { shouldValidate: true })
            form.setValue(`items.${index}.item_id`, '', { shouldValidate: true })
            form.setValue(`items.${index}.product_name`, '', { shouldValidate: true })
            form.setValue(`items.${index}.product_type`, '', { shouldValidate: true })
            form.setValue(`items.${index}.unit_price`, 0, { shouldValidate: true })
            form.setValue(`items.${index}.discount`, 0, { shouldValidate: true })
          }}><option value="catalog">Select produced product</option><option value="manual">Enter details manually</option></Select></Field>
          {!line?.manual ? <RemoteSelect<InventoryPosition> label={`Select product ${index + 1}`} endpoint="/inventory/finished" queryKey="quotation-product-position" query={{ produced_only: true }} value={line?.item_id ?? ''} onChange={(value) => form.setValue(`items.${index}.item_id`, value, { shouldValidate: true })} onSelectItem={(item) => {
            setSelectedItems((current) => { const next = { ...current }; if (item) next[field.id] = item; else delete next[field.id]; return next })
            form.setValue(`items.${index}.quantity`, item ? 1 : 0, { shouldValidate: true })
            form.setValue(`items.${index}.unit_price`, item ? suggestedUnitPrice(item) : 0, { shouldValidate: true })
            form.setValue(`items.${index}.discount`, 0, { shouldValidate: true })
          }} optionValue={(item) => item.item_id} optionLabel={(item) => `${item.item_name} · ${item.product_type || 'No type'} · ${money(item.selling_price)} · ${quantity(item.quantity_on_hand)} available`} required error={form.formState.errors.items?.[index]?.item_id?.message} selectedLabel={savedLine?.item_id ? `${savedLine.product_name} · ${savedLine.product_type || 'No type'}` : undefined} /> : <div className="quotation-manual-fields"><Field label="Product name" required error={form.formState.errors.items?.[index]?.product_name?.message}><Input {...form.register(`items.${index}.product_name`)} placeholder="Enter product details" /></Field><Field label="Product type"><Input {...form.register(`items.${index}.product_type`)} placeholder="Optional category or type" /></Field></div>}
          <div className="calculated-field calculated-field--stock"><span>Product details</span><strong>{line?.manual ? line.product_type || 'Manual item' : selected?.product_type || savedLine?.product_type || 'Select product'}</strong><small>{line?.manual ? line.product_name || 'Enter the product name and price' : selected ? `${selected.sku || 'No SKU'} · ${quantity(selected.quantity_on_hand)} ${selected.unit} available · saved price ${money(selected.selling_price)}` : savedLine ? savedLine.item?.sku || 'Saved quotation product' : 'Loaded from production stock'}</small></div>
          <Field label="Quantity" required error={form.formState.errors.items?.[index]?.quantity?.message}><Input type="number" min="0.000001" step="0.001" {...form.register(`items.${index}.quantity`)} /></Field>
          <Field label="Unit price" required error={form.formState.errors.items?.[index]?.unit_price?.message}><Input type="number" min="0.01" step="0.01" {...form.register(`items.${index}.unit_price`)} /></Field>
          <Field label="Discount" error={form.formState.errors.items?.[index]?.discount?.message}><Input type="number" min="0" step="0.01" {...form.register(`items.${index}.discount`)} /></Field>
          <div className="calculated-field"><span>Line total</span><strong>{money(lineTotal)}</strong></div>
          <button type="button" className="icon-button icon-button--danger" disabled={fields.fields.length <= 1} onClick={() => fields.remove(index)} aria-label={`Remove quotation line ${index + 1}`}><Trash2 size={17} /></button>
        </Card>
      })}</div>
      <div className="form-grid form-grid--two">
        <Field label="Terms & conditions"><Textarea rows={3} {...form.register('terms')} /></Field>
        <Field label="Notes"><Textarea rows={3} {...form.register('notes')} /></Field>
      </div>
      <div className="form-total"><span>Quotation total</span><strong>{money(total)}</strong></div>
    </form>
  </Dialog>
}

function QuotationActionsDialog({ quotationId, onClose }: { quotationId: string | null; onClose: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState<'download' | 'share' | 'print' | null>(null)
  const query = useQuery({ queryKey: ['quotations', 'pdf', quotationId], queryFn: ({ signal }) => api.get<Quotation>(`/quotations/${quotationId}`, undefined, signal), enabled: Boolean(quotationId) })
  const companyQuery = useQuery({ queryKey: ['company-profile'], queryFn: ({ signal }) => api.get<CompanyProfile>('/company-profile', undefined, signal), enabled: Boolean(quotationId), staleTime: 60_000 })
  const quotation = query.data
  const phone = normalizeWhatsAppPhone(quotation?.customer_phone)
  const input = quotation && companyQuery.data ? { quotation, company: companyQuery.data } : null
  const download = async () => {
    if (!input) return
    setBusy('download')
    try { await downloadQuotationPdf(input); toast.success('Quotation PDF downloaded', 'The PDF is ready to print, email, or attach elsewhere.') }
    catch (error) { toast.error('PDF could not be generated', error instanceof Error ? error.message : 'Try again.') }
    finally { setBusy(null) }
  }
  const share = async () => {
    if (!input) return
    setBusy('share')
    try {
      const result = await shareQuotationPdf(input)
      if (result === 'downloaded') {
        if (phone) window.open(`https://wa.me/${phone}?text=${encodeURIComponent(quotationWhatsAppMessage(input.quotation))}`, '_blank', 'noopener,noreferrer')
        toast.success('Quotation PDF downloaded', phone ? 'WhatsApp opened. Attach the downloaded PDF to the message.' : 'Attach the downloaded PDF in WhatsApp or email.')
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      toast.error('PDF could not be shared', error instanceof Error ? error.message : 'Try again.')
    } finally { setBusy(null) }
  }
  const print = async () => {
    if (!input) return
    setBusy('print')
    try { if (!await printQuotationPdf(input)) toast.error('Print preview did not open', 'Allow pop-ups for this site and try again.') }
    catch (error) { toast.error('Quotation could not be prepared', error instanceof Error ? error.message : 'Try again.') }
    finally { setBusy(null) }
  }
  return <Dialog open={Boolean(quotationId)} title={quotation ? `Quotation ${quotation.quotation_no}` : 'Saved quotation'} description="Review, print, download, or send the saved quotation as a PDF." size="large" onClose={onClose} closeDisabled={Boolean(busy)} footer={<><Button variant="secondary" onClick={onClose} disabled={Boolean(busy)}>Close</Button><Button variant="secondary" icon={MessageCircle} loading={busy === 'share'} disabled={!input || Boolean(busy && busy !== 'share')} onClick={() => void share()}>WhatsApp</Button><Button variant="secondary" icon={Printer} loading={busy === 'print'} disabled={!input || Boolean(busy && busy !== 'print')} onClick={() => void print()}>Print</Button><Button icon={Download} loading={busy === 'download'} disabled={!input || Boolean(busy && busy !== 'download')} onClick={() => void download()}>Save PDF / Download</Button></>}>
    {query.isLoading || companyQuery.isLoading ? <LoadingState label="Preparing quotation…" /> : query.isError || companyQuery.isError ? <ErrorState error={query.error ?? companyQuery.error} onRetry={() => { void query.refetch(); void companyQuery.refetch() }} /> : quotation ? <div className="invoice-preview">
      <div className="invoice-preview__header"><div><span className="eyebrow">Quotation for</span><h3>{quotation.customer_name}</h3><p>{quotation.customer_phone || quotation.customer_email || 'No customer contact details'}</p><p>{titleCase(quotation.payment_method || 'accounts_receivable')}</p></div><div><strong className="mono">{quotation.quotation_no}</strong><span>{shortDate(quotation.quotation_date)} · valid to {shortDate(quotation.valid_until)}</span><Badge>{titleCase(quotation.status)}</Badge></div></div>
      <TableWrap><table><thead><tr><th>Product</th><th>Type</th><th className="numeric">Qty</th><th className="numeric">Unit price</th><th className="numeric">Discount</th><th className="numeric">Amount</th></tr></thead><tbody>{quotation.quotation_items.map((line) => <tr key={line.id}><td><strong>{line.product_name}</strong><span className="table-subtext">{line.item?.sku || 'Manual item'}</span></td><td>{line.product_type || line.item?.product_type || 'Manual item'}</td><td className="numeric">{quantity(line.quantity, 3)}</td><td className="numeric">{money(line.unit_price)}</td><td className="numeric">{money(line.discount)}</td><td className="numeric"><strong>{money(line.line_total)}</strong></td></tr>)}</tbody></table></TableWrap>
      <div className="invoice-preview__totals"><span>Discount <strong>{money(quotation.discount_total)}</strong></span><span>Total <strong>{money(quotation.total_amount)}</strong></span></div>
      {quotation.terms ? <InlineNotice tone="info" title="Terms">{quotation.terms}</InlineNotice> : null}
    </div> : null}
  </Dialog>
}

function SalesTable({ query, page, setPage, editingSaleId, onInvoice, onEdit, onPayment, onReverse }: {
  query: ReturnType<typeof useQuery<Page<Sale>>>
  page: number
  setPage: (page: number) => void
  editingSaleId?: string | undefined
  onInvoice: (sale: Sale) => void
  onEdit: (sale: Sale) => void
  onPayment: (sale: Sale) => void
  onReverse: (sale: Sale) => void
}) {
  const rows = query.data?.items ?? []
  if (query.isLoading) return <LoadingState />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  if (!rows.length) return <EmptyState message="No invoices match the selected period and search." />
  return (
    <><TableWrap><table><thead><tr><th>Date / invoice</th><th>Customer</th><th className="numeric">Lines</th><th className="numeric">Total</th><th className="numeric">Paid</th><th className="numeric">Due</th><th>Status</th><th className="no-print"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{rows.map((sale) => <tr key={sale.id}>
        <td><strong className="mono">{sale.invoice_no}</strong><span className="table-subtext">{shortDate(sale.sale_date)} · {sale.reference_no}</span></td>
        <td><strong>{sale.customer_name}</strong><span className="table-subtext">{sale.customer_phone || 'No phone'}</span></td>
        <td className="numeric">{saleLines(sale).length}</td><td className="numeric">{money(sale.total_amount)}</td><td className="numeric">{money(sale.paid_amount)}</td><td className="numeric"><strong>{money(sale.balance_due)}</strong></td>
        <td><div className="status-stack"><Badge tone={statusTone(sale.status === 'reversed' ? 'reversed' : sale.document_status === 'completed' ? 'posted' : undefined)}>{titleCase(sale.status === 'reversed' ? 'reversed' : sale.document_status ?? 'issued')}</Badge>{sale.status !== 'reversed' ? <Badge tone={statusTone(sale.payment_status)}>{titleCase(sale.payment_status ?? 'unpaid')}</Badge> : null}</div></td>
        <td className="no-print"><div className="row-actions"><Button size="small" variant="ghost" icon={ReceiptText} onClick={() => onInvoice(sale)}>Invoice</Button><Button size="small" variant="ghost" icon={Banknote} disabled={sale.status === 'reversed'} onClick={() => onPayment(sale)}>Receipts</Button><Button size="small" variant="ghost" icon={Pencil} loading={editingSaleId === sale.id} disabled={sale.status === 'reversed' || Boolean(editingSaleId && editingSaleId !== sale.id)} onClick={() => onEdit(sale)}>Correct</Button><Button size="small" variant="ghost" icon={RotateCcw} disabled={sale.status === 'reversed'} onClick={() => onReverse(sale)}>Reverse</Button></div></td>
      </tr>)}</tbody></table></TableWrap><Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} /></>
  )
}

function SaleDialog({ open, record, mutation, onClose }: {
  open: boolean
  record: Sale | null
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { id?: string | undefined; body: SaleValues }>>
  onClose: () => void
}) {
  const [selectedItems, setSelectedItems] = useState<Record<string, InventoryPosition>>({})
  const form = useForm<SaleValues>({
    resolver: zodResolver(saleSchema),
    values: {
      invoice_no: record?.invoice_no ?? '',
      sale_date: record?.sale_date ?? localIsoDate(),
      customer_name: record?.customer_name ?? '',
      customer_phone: record?.customer_phone ?? '',
      payment_method: paymentMethods.includes(record?.payment_method as typeof paymentMethods[number]) ? record?.payment_method as typeof paymentMethods[number] : 'accounts_receivable',
      document_status: record?.document_status ?? 'issued',
      amount_paid: record ? 0 : 0,
      items: (record ? saleLines(record) : []).map((line) => ({ item_id: line.item_id, quantity: numberValue(line.quantity), unit_price: numberValue(line.unit_price), discount: numberValue(line.discount) })).concat(record ? [] : [{ item_id: '', quantity: 1, unit_price: 0, discount: 0 }]),
    },
  })
  const fields = useFieldArray({ control: form.control, name: 'items' })
  const items = form.watch('items')
  const total = items.reduce((sum, line) => sum + numberValue(line.quantity) * numberValue(line.unit_price) - numberValue(line.discount), 0)
  const submit = form.handleSubmit((body) => mutation.mutate({ id: record?.id, body: { ...body, invoice_no: record?.invoice_no } }))

  useEffect(() => {
    setSelectedItems({})
  }, [open, record?.id])

  return (
    <Dialog open={open} title={record ? 'Correct invoice' : 'New invoice'} description="Availability, weighted COGS, and all journal lines are recalculated by the server." size="wide" onClose={onClose} closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={ShoppingCart} loading={mutation.isPending} onClick={() => void submit()}>Save invoice</Button></>}>
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <div className="form-grid form-grid--three">
          <Field label="Invoice number" hint="Generated by month when saved; the sequence resets each new month."><Input value={record?.invoice_no ?? `Automatic · CK-INV-${form.watch('sale_date').replaceAll('-', '').slice(0, 6)}-0001`} readOnly aria-label="Invoice number" /></Field>
          <Field label="Sale date" required error={form.formState.errors.sale_date?.message}><Input type="date" {...form.register('sale_date')} /></Field>
          <Field label="Customer name" required error={form.formState.errors.customer_name?.message}><Input {...form.register('customer_name')} /></Field>
          <Field label="Customer phone" error={form.formState.errors.customer_phone?.message}><Input type="tel" {...form.register('customer_phone')} /></Field>
          <Field label="Invoice status" required><Select {...form.register('document_status')}><option value="issued">Issued</option><option value="delivered">Delivered</option><option value="completed">Completed</option></Select></Field>
          <Field label="Initial payment method" required><Select {...form.register('payment_method')}>{paymentMethods.map((method) => <option value={method} key={method}>{titleCase(method)}</option>)}</Select></Field>
          <Field label="Initial amount paid" error={form.formState.errors.amount_paid?.message}><Input type="number" min="0" step="0.01" {...form.register('amount_paid')} /></Field>
        </div>
        <SectionTitle title="Invoice items" description="Selecting a produced finished item loads its Add Product selling price. Unit price stays editable; quantity and discount update the line total instantly." actions={<Button type="button" size="small" variant="secondary" icon={Plus} onClick={() => fields.append({ item_id: '', quantity: 1, unit_price: 0, discount: 0 })}>Add line</Button>} />
        <div className="line-card-list">
          {fields.fields.map((field, index) => {
            const line = items[index]
            const selectedItem = selectedItems[field.id]
            const currentRecordLine = record ? saleLines(record)[index] : undefined
            const originalLine = record ? saleLines(record).find((item) => item.item_id === line?.item_id) : undefined
            const available = selectedItem
              ? numberValue(selectedItem.quantity_on_hand) + numberValue(originalLine?.quantity)
              : null
            const lineTotal = numberValue(line?.quantity) * numberValue(line?.unit_price) - numberValue(line?.discount)
            return <Card className="line-card line-card--sale" key={field.id}>
              <RemoteSelect<InventoryPosition>
                label={`Item ${index + 1}`}
                endpoint="/inventory/finished"
                queryKey="sale-finished-item-position"
                query={{ produced_only: true, available_only: true }}
                value={line?.item_id ?? ''}
                onChange={(value) => form.setValue(`items.${index}.item_id`, value, { shouldValidate: true })}
                onSelectItem={(item) => {
                  setSelectedItems((current) => {
                    if (!item) {
                      const next = { ...current }
                      delete next[field.id]
                      return next
                    }
                    return { ...current, [field.id]: item }
                  })
                  form.setValue(`items.${index}.quantity`, item ? 1 : 0, { shouldValidate: true })
                  form.setValue(`items.${index}.unit_price`, item ? suggestedUnitPrice(item) : 0, { shouldValidate: true })
                  form.setValue(`items.${index}.discount`, 0, { shouldValidate: true })
                }}
                optionValue={(item) => item.item_id}
                optionLabel={(item) => `${item.item_name} · ${item.sku || 'No SKU'} · ${money(item.selling_price)} · ${quantity(item.quantity_on_hand, 3)} ${item.unit} available`}
                required
                error={form.formState.errors.items?.[index]?.item_id?.message}
                selectedLabel={currentRecordLine ? `${saleLineName(currentRecordLine)} · current invoice item` : undefined}
              />
              <div className="calculated-field calculated-field--stock" aria-live="polite">
                <span>Available stock</span>
                <strong>{available === null ? 'Select item' : `${quantity(available, 3)} ${selectedItem?.unit ?? ''}`}</strong>
                <small>{selectedItem ? `Saved price ${money(selectedItem.selling_price)} · weighted cost ${money(selectedItem.average_unit_cost)}` : 'Loaded from live finished-goods stock'}</small>
              </div>
              <Field label="Quantity" required error={form.formState.errors.items?.[index]?.quantity?.message}><Input type="number" min="0.000001" step="0.001" {...form.register(`items.${index}.quantity`)} /></Field>
              <Field label="Unit price" required hint="Auto-filled; you can change it." error={form.formState.errors.items?.[index]?.unit_price?.message}><Input type="number" min="0.01" step="0.01" {...form.register(`items.${index}.unit_price`)} /></Field>
              <Field label="Discount" error={form.formState.errors.items?.[index]?.discount?.message}><Input type="number" min="0" step="0.01" {...form.register(`items.${index}.discount`)} /></Field>
              <div className="calculated-field"><span>Line total</span><strong>{money(lineTotal)}</strong></div>
              <button type="button" className="icon-button icon-button--danger" disabled={fields.fields.length <= 1} onClick={() => fields.remove(index)} aria-label={`Remove invoice line ${index + 1}`}><Trash2 size={17} /></button>
            </Card>
          })}
        </div>
        <div className="form-total"><span>Invoice total</span><strong>{money(total)}</strong></div>
      </form>
    </Dialog>
  )
}

function escapeInvoiceHtml(value: unknown) {
  const text = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
      ? `${value}`
      : ''
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function printInvoice(sale: Sale) {
  const popup = window.open('', '_blank')
  if (!popup) return false
  popup.opener = null
  const rows = saleLines(sale).map((line) => {
    const lineTotal = numberValue(line.line_total) || (
      numberValue(line.quantity) * numberValue(line.unit_price) - numberValue(line.discount)
    )
    return `<tr>
      <td>${escapeInvoiceHtml(saleLineName(line))}</td>
      <td class="number">${escapeInvoiceHtml(quantity(line.quantity, 3))}</td>
      <td class="number">${escapeInvoiceHtml(money(line.unit_price))}</td>
      <td class="number">${escapeInvoiceHtml(money(line.discount))}</td>
      <td class="number"><strong>${escapeInvoiceHtml(money(lineTotal))}</strong></td>
    </tr>`
  }).join('')
  popup.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${escapeInvoiceHtml(sale.invoice_no)}</title><style>
    *{box-sizing:border-box}body{margin:0;padding:36px;color:#172033;font:14px Arial,sans-serif}.sheet{max-width:900px;margin:0 auto}.head{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid #2457d6;padding-bottom:20px}.brand{font-size:25px;font-weight:800;color:#173e9b}.meta{text-align:right}.meta h1{margin:0 0 8px;font-size:24px}.meta p,.customer p{margin:4px 0;color:#566278}.customer{display:flex;justify-content:space-between;gap:24px;padding:24px 0}.customer strong{display:block;margin-bottom:6px;font-size:16px}table{width:100%;border-collapse:collapse}th,td{padding:11px 10px;border-bottom:1px solid #dde3ec;text-align:left}th{background:#f3f6fb;color:#566278;font-size:11px;text-transform:uppercase}.number{text-align:right}.totals{width:min(100%,360px);margin:22px 0 0 auto}.total-row{display:flex;justify-content:space-between;padding:7px 0}.total-row.grand{margin-top:5px;padding-top:12px;border-top:2px solid #172033;font-size:18px}.footer{margin-top:54px;padding-top:16px;border-top:1px solid #dde3ec;color:#69758a;font-size:12px}@media print{body{padding:0}@page{size:A4;margin:16mm}}
  </style></head><body><main class="sheet"><header class="head"><div><div class="brand">CK SYS</div><p>Sales invoice</p></div><div class="meta"><h1>INVOICE</h1><p><strong>${escapeInvoiceHtml(sale.invoice_no)}</strong></p><p>${escapeInvoiceHtml(shortDate(sale.sale_date))}</p><p>${escapeInvoiceHtml(sale.reference_no)}</p></div></header><section class="customer"><div><strong>Bill to</strong><p>${escapeInvoiceHtml(sale.customer_name)}</p><p>${escapeInvoiceHtml(sale.customer_phone || 'No phone number')}</p></div><div class="meta"><strong>Status</strong><p>${escapeInvoiceHtml(titleCase(sale.payment_status ?? 'unpaid'))}</p></div></section><table><thead><tr><th>Item</th><th class="number">Quantity</th><th class="number">Unit price</th><th class="number">Discount</th><th class="number">Amount</th></tr></thead><tbody>${rows}</tbody></table><section class="totals"><div class="total-row"><span>Paid</span><strong>${escapeInvoiceHtml(money(sale.paid_amount))}</strong></div><div class="total-row"><span>Balance due</span><strong>${escapeInvoiceHtml(money(sale.balance_due))}</strong></div><div class="total-row grand"><span>Total</span><strong>${escapeInvoiceHtml(money(sale.total_amount))}</strong></div></section><footer class="footer">Thank you for your business.</footer></main></body></html>`)
  popup.document.close()
  popup.focus()
  window.setTimeout(() => popup.print(), 150)
  return true
}

function InvoiceActionsDialog({ saleId, onClose }: { saleId: string | null; onClose: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState<'share' | 'print' | 'download' | null>(null)
  const invoiceQuery = useQuery({
    queryKey: ['sales', 'invoice', saleId],
    queryFn: ({ signal }) => api.get<Sale>(`/sales/${saleId}`, undefined, signal),
    enabled: Boolean(saleId),
  })
  const companyQuery = useQuery({
    queryKey: ['company-profile'],
    queryFn: ({ signal }) => api.get<CompanyProfile>('/company-profile', undefined, signal),
    enabled: Boolean(saleId),
    staleTime: 60_000,
  })
  const sale = invoiceQuery.data
  const whatsappPhone = normalizeWhatsAppPhone(sale?.customer_phone)
  const input = sale && companyQuery.data ? { sale, company: companyQuery.data } : null
  const sendWhatsApp = async () => {
    if (!input) return
    setBusy('share')
    try {
      const result = await shareSalesInvoicePdf(input, invoiceWhatsAppMessage(input.sale))
      if (result === 'downloaded') {
        if (whatsappPhone) window.open(`https://wa.me/${whatsappPhone}?text=${encodeURIComponent(invoiceWhatsAppMessage(input.sale))}`, '_blank', 'noopener,noreferrer')
        toast.success('Invoice PDF downloaded', whatsappPhone ? 'WhatsApp opened. Attach the downloaded invoice PDF.' : 'Attach the downloaded PDF in WhatsApp.')
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) toast.error('Invoice could not be shared', error instanceof Error ? error.message : 'Try again.')
    } finally { setBusy(null) }
  }
  const print = async () => {
    if (!input) return
    setBusy('print')
    try { if (!await printSalesInvoicePdf(input) && !printInvoice(input.sale)) toast.error('Print preview did not open', 'Allow pop-ups for this site and try again.') }
    catch (error) { toast.error('Invoice could not be prepared', error instanceof Error ? error.message : 'Try again.') }
    finally { setBusy(null) }
  }
  const download = async () => {
    if (!input) return
    setBusy('download')
    try { await downloadSalesInvoicePdf(input); toast.success('Invoice downloaded', `${input.sale.invoice_no} was saved as a PDF.`) }
    catch (error) { toast.error('Invoice could not be downloaded', error instanceof Error ? error.message : 'Try again.') }
    finally { setBusy(null) }
  }

  return (
    <Dialog
      open={Boolean(saleId)}
      title={sale ? `Invoice ${sale.invoice_no}` : 'Saved invoice'}
      description="Review, print, download, or send the saved invoice as a PDF."
      size="large"
      onClose={onClose}
      closeDisabled={Boolean(busy)}
      footer={<><Button variant="secondary" onClick={onClose} disabled={Boolean(busy)}>Close</Button><Button variant="secondary" icon={MessageCircle} loading={busy === 'share'} disabled={!input || Boolean(busy && busy !== 'share')} onClick={() => void sendWhatsApp()}>WhatsApp</Button><Button variant="secondary" icon={Printer} loading={busy === 'print'} disabled={!input || Boolean(busy && busy !== 'print')} onClick={() => void print()}>Print</Button><Button icon={Download} loading={busy === 'download'} disabled={!input || Boolean(busy && busy !== 'download')} onClick={() => void download()}>Save PDF / Download</Button></>}
    >
      {invoiceQuery.isLoading || companyQuery.isLoading ? <LoadingState label="Preparing invoice…" /> : invoiceQuery.isError || companyQuery.isError ? <ErrorState error={invoiceQuery.error ?? companyQuery.error} onRetry={() => { void invoiceQuery.refetch(); void companyQuery.refetch() }} /> : sale ? (
        <div className="invoice-preview">
          <div className="invoice-preview__header"><div><span className="eyebrow">Sales invoice</span><h3>{sale.customer_name}</h3><p>{sale.customer_phone || 'No customer phone number saved'}</p><p>{titleCase(sale.payment_method || 'accounts_receivable')}</p></div><div><strong className="mono">{sale.invoice_no}</strong><span>{shortDate(sale.sale_date)}</span><Badge tone={sale.status === 'reversed' ? 'danger' : sale.document_status === 'completed' ? 'success' : 'info'}>{titleCase(sale.status === 'reversed' ? 'reversed' : sale.document_status ?? 'issued')}</Badge><Badge tone={statusTone(sale.payment_status)}>{titleCase(sale.payment_status ?? 'unpaid')}</Badge></div></div>
          <TableWrap><table><thead><tr><th>Item</th><th className="numeric">Qty</th><th className="numeric">Unit price</th><th className="numeric">Discount</th><th className="numeric">Amount</th></tr></thead><tbody>{saleLines(sale).map((line) => <tr key={line.id}><td><strong>{saleLineName(line)}</strong><span className="table-subtext">{line.item?.sku || line.item_id.slice(0, 8)}</span></td><td className="numeric">{quantity(line.quantity, 3)}</td><td className="numeric">{money(line.unit_price)}</td><td className="numeric">{money(line.discount)}</td><td className="numeric"><strong>{money(line.line_total)}</strong></td></tr>)}</tbody></table></TableWrap>
          <div className="invoice-preview__totals"><span>Paid <strong>{money(sale.paid_amount)}</strong></span><span>Balance <strong>{money(sale.balance_due)}</strong></span><span>Total <strong>{money(sale.total_amount)}</strong></span></div>
          {!whatsappPhone ? <InlineNotice tone="warning" title="WhatsApp needs a phone number">Add a valid customer phone number to this invoice to enable WhatsApp.</InlineNotice> : null}
        </div>
      ) : null}
    </Dialog>
  )
}

function PaymentDialog({ sale, mutation, onReverse, onClose }: {
  sale: Sale | null
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { saleId: string; body: PaymentValues }>>
  onReverse: (payment: Payment) => void
  onClose: () => void
}) {
  const form = useForm<PaymentValues>({ resolver: zodResolver(paymentSchema), values: { payment_date: localIsoDate(), amount: numberValue(sale?.balance_due), method: 'cash', notes: '' } })
  const submit = form.handleSubmit((body) => { if (sale) mutation.mutate({ saleId: sale.id, body }) })
  return (
    <Dialog open={Boolean(sale)} title={`Receipts · ${sale?.invoice_no ?? ''}`} description={`Current balance: ${money(sale?.balance_due)}`} size="large" onClose={onClose} closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button icon={Banknote} loading={mutation.isPending} disabled={!sale || numberValue(sale.balance_due) <= 0} onClick={() => void submit()}>Post receipt</Button></>}>
      <form className="form-grid form-grid--two" onSubmit={(event) => void submit(event)}>
        <Field label="Payment date" required error={form.formState.errors.payment_date?.message}><Input type="date" {...form.register('payment_date')} /></Field>
        <Field label="Amount" required error={form.formState.errors.amount?.message}><Input type="number" min="0.01" max={numberValue(sale?.balance_due) || undefined} step="0.01" {...form.register('amount')} /></Field>
        <Field label="Method" required><Select {...form.register('method')}>{paymentMethods.filter((method) => method !== 'credit' && method !== 'accounts_receivable').map((method) => <option value={method} key={method}>{titleCase(method)}</option>)}</Select></Field>
        <Field label="Notes"><Textarea rows={2} {...form.register('notes')} /></Field>
      </form>
      <SectionTitle title="Receipt history" />
      {sale && salePayments(sale).length ? <TableWrap><table><thead><tr><th>Date / reference</th><th>Method</th><th className="numeric">Amount</th><th>Status</th><th /></tr></thead><tbody>{salePayments(sale).map((payment) => <tr key={payment.id}><td><strong className="mono">{payment.reference_no}</strong><span className="table-subtext">{shortDate(payment.payment_date)}</span></td><td>{titleCase(payment.method)}</td><td className="numeric">{money(payment.amount)}</td><td><Badge tone={statusTone(payment.status)}>{titleCase(payment.status ?? 'posted')}</Badge></td><td><Button size="small" variant="ghost" icon={RotateCcw} disabled={payment.status === 'reversed'} onClick={() => onReverse(payment)}>Reverse</Button></td></tr>)}</tbody></table></TableWrap> : <EmptyState message="No receipts have been posted for this invoice." />}
    </Dialog>
  )
}
