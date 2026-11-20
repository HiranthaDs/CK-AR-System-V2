import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { Download, MessageCircle, PackagePlus, Plus, Printer, Save, Trash2, Wrench } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useFieldArray, useForm } from 'react-hook-form'
import { z } from 'zod/v3'
import { api } from '../lib/api'
import { localIsoDate, money, numberValue, quantity, shortDate, titleCase } from '../lib/format'
import {
  downloadRawMaterialPurchaseInvoicePdf,
  printRawMaterialPurchaseInvoice,
  rawMaterialPurchaseWhatsAppMessage,
  shareRawMaterialPurchaseInvoice,
} from '../lib/rawMaterialPurchaseInvoice'
import { normalizeWhatsAppPhone } from '../lib/salesInvoice'
import type { BulkRmRate, CompanyProfile, MutationReceipt, RawMaterialPurchase } from '../types/api'
import { Dialog } from './Dialog'
import { useToast } from './Toast'
import { Button, EmptyState, ErrorState, Field, InlineNotice, Input, LoadingState, Select, TableWrap, Textarea } from './UI'

export const BULK_RM_TYPES = [
  'ABS',
  'HIPS',
  'PP - Polypropylene',
  'HDPE - High Density Polyethylene',
  'LDPE - Low Density Polyethylene',
  'LLDPE - Linear Low Density Polyethylene',
  'PET - Polyethylene Terephthalate',
  'PVC - Polyvinyl Chloride',
  'Black Masterbatch',
  'Color Masterbatch',
  'Packing Bags',
] as const

const rateSchema = z.object({
  id: z.string().optional(),
  material_type: z.string().trim().min(1, 'Bulk RM type is required.').max(160),
  rate_per_kg: z.coerce.number().positive('Rate per kg must be greater than zero.'),
  effective_from: z.string().min(1, 'Effective-from date is required.'),
  effective_to: z.string().optional(),
  status: z.enum(['active', 'inactive']),
  notes: z.string().trim().max(2000).optional(),
}).refine((value) => !value.effective_to || value.effective_to >= value.effective_from, {
  message: 'Effective-to date cannot be before effective-from date.',
  path: ['effective_to'],
})

const purchaseLineSchema = z.object({
  bulk_rm_rate_id: z.string().uuid('Select a Bulk RM type.'),
  quantity_kg: z.coerce.number().positive('Quantity must be greater than zero.'),
  rate_per_kg: z.coerce.number().positive('Rate must be greater than zero.'),
  total_cost: z.coerce.number().positive('Total cost must be greater than zero.'),
  notes: z.string().max(2000).optional(),
})

const purchaseSchema = z.object({
  id: z.string().optional(),
  reference_no: z.string().optional(),
  purchase_date: z.string().min(1, 'Purchase date is required.'),
  payment_method: z.enum(['cash', 'bank_transfer', 'cheque', 'credit']),
  supplier_name: z.string().max(160).optional(),
  supplier_phone: z.string().max(40).optional(),
  lorry_no: z.string().max(80).optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(purchaseLineSchema).min(1, 'Add at least one raw material.').max(100),
}).superRefine((value, context) => {
  const ids = value.items.map((item) => item.bulk_rm_rate_id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Each Bulk RM type may appear only once per consignment.', path: ['items'] })
  }
})

type BulkRmRateValues = z.infer<typeof rateSchema>
export type BulkRmPurchaseValues = z.infer<typeof purchaseSchema>
export type BulkRmPurchaseMutationInput = { id?: string; body: Record<string, unknown> }

function rateIsEffective(rate: BulkRmRate, date: string) {
  return rate.status === 'active' && rate.effective_from <= date && (!rate.effective_to || rate.effective_to >= date)
}

function purchaseDefaults(record: RawMaterialPurchase | null): BulkRmPurchaseValues {
  const purchaseItems = record?.purchase_items
    ? [...record.purchase_items].sort((left, right) => (left.line_no ?? Number.MAX_SAFE_INTEGER) - (right.line_no ?? Number.MAX_SAFE_INTEGER))
    : []
  const items = purchaseItems.length
    ? purchaseItems.map((line) => ({
      bulk_rm_rate_id: line.bulk_rm_rate_id ?? '',
      quantity_kg: numberValue(line.quantity_kg),
      rate_per_kg: numberValue(line.rate_per_kg) || numberValue(line.total_cost) / Math.max(numberValue(line.quantity_kg), 1),
      total_cost: numberValue(line.total_cost),
      notes: line.notes ?? '',
    }))
    : [{ bulk_rm_rate_id: '', quantity_kg: 0, rate_per_kg: 0, total_cost: 0, notes: '' }]
  return {
    id: record?.id,
    reference_no: record?.reference_no ?? '',
    purchase_date: record?.purchase_date ?? localIsoDate(),
    payment_method: (record?.payment_method as BulkRmPurchaseValues['payment_method']) ?? 'credit',
    supplier_name: record?.supplier_name ?? '',
    supplier_phone: record?.supplier_phone ?? '',
    lorry_no: record?.lorry_no ?? '',
    notes: record?.notes ?? '',
    items,
  }
}

export function BulkRmRateDialog({ open, record, onClose }: {
  open: boolean
  record: BulkRmRate | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [manualType, setManualType] = useState(false)
  const form = useForm<BulkRmRateValues>({ resolver: zodResolver(rateSchema), values: {
    id: record?.id,
    material_type: record?.material_type ?? '',
    rate_per_kg: numberValue(record?.rate_per_kg),
    effective_from: record?.effective_from ?? localIsoDate(),
    effective_to: record?.effective_to ?? '',
    status: record?.status ?? 'active',
    notes: record?.notes ?? '',
  } })
  useEffect(() => {
    const type = record?.material_type ?? ''
    setManualType(Boolean(type && !BULK_RM_TYPES.includes(type as typeof BULK_RM_TYPES[number])))
  }, [open, record?.id, record?.material_type])
  const mutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Record<string, unknown> }) => id
      ? api.patch<MutationReceipt, Record<string, unknown>>(`/bulk-rm-rates/${id}`, body)
      : api.post<MutationReceipt, Record<string, unknown>>('/bulk-rm-rates', body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bulk-rm-rates'] })
      toast.success('Bulk RM rate saved', 'The effective rate is ready for lorry and consignment purchases.')
      onClose()
    },
    onError: (error) => toast.error('Bulk RM rate not saved', error.message),
  })
  const submit = form.handleSubmit(({ id, ...values }) => mutation.mutate({
    ...(id ? { id } : {}),
    body: { ...values, effective_to: values.effective_to || null, notes: values.notes || null },
  }))
  return <Dialog open={open} onClose={onClose} title={record ? 'Edit Bulk RM rate' : 'Add Bulk RM rate'} description="Maintain effective-dated purchase rates. Historical purchases retain their saved rate snapshots." closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={Save} loading={mutation.isPending} onClick={() => void submit()}>Save rate</Button></>}>
    <form className="form-grid form-grid--two" onSubmit={(event) => void submit(event)}>
      <Field label="Bulk RM type" required error={form.formState.errors.material_type?.message} hint="Choose a standard material or use Other for manual entry.">
        <Select value={manualType ? '__manual__' : form.watch('material_type')} onChange={(event) => {
          if (event.target.value === '__manual__') { setManualType(true); form.setValue('material_type', '', { shouldValidate: true }) }
          else { setManualType(false); form.setValue('material_type', event.target.value, { shouldValidate: true }) }
        }}>
          <option value="">Select Bulk RM type</option>
          {BULK_RM_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          <option value="__manual__">Other — manual entry</option>
        </Select>
        {manualType ? <Input value={form.watch('material_type')} onChange={(event) => form.setValue('material_type', event.target.value, { shouldValidate: true })} placeholder="Enter Bulk RM type" autoFocus /> : null}
      </Field>
      <Field label="Rate per kg" required error={form.formState.errors.rate_per_kg?.message}><Input type="number" min="0.000001" step="0.000001" {...form.register('rate_per_kg')} /></Field>
      <Field label="Effective from" required error={form.formState.errors.effective_from?.message}><Input type="date" {...form.register('effective_from')} /></Field>
      <Field label="Effective to" error={form.formState.errors.effective_to?.message} hint="Leave blank for an open-ended rate."><Input type="date" {...form.register('effective_to')} /></Field>
      <Field label="Status"><Select {...form.register('status')}><option value="active">Active</option><option value="inactive">Inactive</option></Select></Field>
      <Field label="Notes" error={form.formState.errors.notes?.message}><Textarea rows={3} {...form.register('notes')} /></Field>
    </form>
  </Dialog>
}

export function BulkRmPurchaseDialog({ open, record, mutation, onClose }: {
  open: boolean
  record: RawMaterialPurchase | null
  mutation: UseMutationResult<MutationReceipt, Error, BulkRmPurchaseMutationInput>
  onClose: () => void
}) {
  const form = useForm<BulkRmPurchaseValues>({ resolver: zodResolver(purchaseSchema), defaultValues: purchaseDefaults(record) })
  const fields = useFieldArray({ control: form.control, name: 'items' })
  const values = form.watch()
  const ratesQuery = useQuery({
    queryKey: ['bulk-rm-rates', 'purchase-entry'],
    queryFn: ({ signal }) => api.list<BulkRmRate>('/bulk-rm-rates', { page: 1, page_size: 100, descending: false }, signal),
    enabled: open,
    staleTime: 30_000,
  })
  const allRates = useMemo(() => ratesQuery.data?.items ?? [], [ratesQuery.data?.items])
  const effectiveRates = useMemo(() => allRates.filter((rate) => rateIsEffective(rate, values.purchase_date)), [allRates, values.purchase_date])
  const grandTotal = values.items.reduce((sum, item) => sum + numberValue(item.total_cost), 0)

  useEffect(() => {
    if (open) form.reset(purchaseDefaults(record))
  }, [form, open, record])

  const recalculateTotal = (index: number, quantityValue?: number, rateValue?: number) => {
    const row = form.getValues(`items.${index}`)
    const nextQuantity = quantityValue ?? numberValue(row.quantity_kg)
    const nextRate = rateValue ?? numberValue(row.rate_per_kg)
    form.setValue(`items.${index}.total_cost`, Math.round(nextQuantity * nextRate * 100) / 100, { shouldValidate: true, shouldDirty: true })
  }
  const chooseRate = (index: number, rateId: string) => {
    const rate = effectiveRates.find((item) => item.id === rateId)
    form.setValue(`items.${index}.bulk_rm_rate_id`, rateId, { shouldValidate: true, shouldDirty: true })
    if (!rate) return
    const savedRate = numberValue(rate.rate_per_kg)
    form.setValue(`items.${index}.rate_per_kg`, savedRate, { shouldValidate: true, shouldDirty: true })
    recalculateTotal(index, undefined, savedRate)
  }
  const changePurchaseDate = (date: string) => {
    form.setValue('purchase_date', date, { shouldValidate: true, shouldDirty: true })
    const nextRates = allRates.filter((rate) => rateIsEffective(rate, date))
    form.getValues('items').forEach((line, index) => {
      const oldRate = allRates.find((rate) => rate.id === line.bulk_rm_rate_id)
      const replacement = oldRate ? nextRates.find((rate) => rate.material_type === oldRate.material_type) : undefined
      if (!replacement) {
        form.setValue(`items.${index}.bulk_rm_rate_id`, '', { shouldValidate: true })
        return
      }
      form.setValue(`items.${index}.bulk_rm_rate_id`, replacement.id, { shouldValidate: true })
      form.setValue(`items.${index}.rate_per_kg`, numberValue(replacement.rate_per_kg), { shouldValidate: true })
      recalculateTotal(index, undefined, numberValue(replacement.rate_per_kg))
    })
  }
  const submit = form.handleSubmit((input) => mutation.mutate({
    ...(input.id ? { id: input.id } : {}),
    body: {
      ...(input.reference_no ? { reference_no: input.reference_no } : {}),
      purchase_date: input.purchase_date,
      payment_method: input.payment_method,
      supplier_name: input.supplier_name || null,
      supplier_phone: input.supplier_phone || null,
      lorry_no: input.lorry_no || null,
      notes: input.notes || null,
      items: input.items.map((line) => ({
        bulk_rm_rate_id: line.bulk_rm_rate_id,
        quantity_kg: line.quantity_kg,
        rate_per_kg: line.rate_per_kg,
        total_cost: Math.round(numberValue(line.quantity_kg) * numberValue(line.rate_per_kg) * 100) / 100,
        notes: line.notes || null,
      })),
    },
  }))

  return <Dialog open={open} onClose={onClose} title={record ? 'Correct raw-material consignment' : 'Post raw-material purchase'} description="Enter one bill or lorry, then add every raw material carried in that consignment." size="wide" closeDisabled={mutation.isPending} footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={PackagePlus} loading={mutation.isPending} onClick={() => void submit()}>Save purchase & create invoice</Button></>}>
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <div className="form-grid form-grid--three">
        <Field label="Purchase date" required error={form.formState.errors.purchase_date?.message}><Input type="date" value={values.purchase_date} onChange={(event) => changePurchaseDate(event.target.value)} /></Field>
        <Field label="Payment method" required><Select {...form.register('payment_method')}><option value="credit">Accounts payable</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option></Select></Field>
        <Field label="Lorry / bill no."><Input {...form.register('lorry_no')} placeholder="Example: WP AB-1234" /></Field>
        <Field label="Supplier name"><Input {...form.register('supplier_name')} /></Field>
        <Field label="Supplier phone"><Input type="tel" {...form.register('supplier_phone')} /></Field>
        <Field label="Consignment notes"><Textarea rows={2} {...form.register('notes')} /></Field>
      </div>
      {ratesQuery.isError ? <InlineNotice tone="warning" title="Bulk RM rates could not be loaded">Close this form, verify the connection, and try again. Purchases can only use active, effective rates.</InlineNotice> : null}
      {!ratesQuery.isLoading && !ratesQuery.isError && !effectiveRates.length ? <InlineNotice tone="warning" title="No active Bulk RM rates for this date">Add and activate a Bulk RM rate before posting this purchase.</InlineNotice> : null}
      <div className="section-title"><div><h2>Raw materials in this consignment</h2><p>Rate is filled from the selected master and remains editable. Total and rate recalculate in both directions.</p></div><Button type="button" variant="secondary" size="small" icon={Plus} onClick={() => fields.append({ bulk_rm_rate_id: '', quantity_kg: 0, rate_per_kg: 0, total_cost: 0, notes: '' })}>Add another RM</Button></div>
      <TableWrap><table className="entry-table"><thead><tr><th>Material</th><th className="numeric">Quantity (kg)</th><th className="numeric">Rate / kg</th><th className="numeric">Total cost</th><th>Notes</th><th /></tr></thead><tbody>{fields.fields.map((field, index) => {
        const row = values.items[index]
        const selected = allRates.find((rate) => rate.id === row?.bulk_rm_rate_id)
        return <tr key={field.id}>
          <td><Select aria-label={`Material ${index + 1}`} value={row?.bulk_rm_rate_id ?? ''} onChange={(event) => chooseRate(index, event.target.value)}><option value="">Select active Bulk RM</option>{selected && !effectiveRates.some((rate) => rate.id === selected.id) ? <option value={selected.id} disabled>{selected.material_type} — not effective</option> : null}{effectiveRates.map((rate) => <option value={rate.id} key={rate.id}>{rate.material_type} · {money(rate.rate_per_kg)}/kg</option>)}</Select>{form.formState.errors.items?.[index]?.bulk_rm_rate_id?.message ? <span className="field__error">{form.formState.errors.items[index]?.bulk_rm_rate_id?.message}</span> : null}</td>
          <td><Input aria-label={`Quantity ${index + 1}`} type="number" min="0.000001" step="0.001" value={row?.quantity_kg ?? 0} onChange={(event) => { const value = Number(event.target.value); form.setValue(`items.${index}.quantity_kg`, value, { shouldValidate: true, shouldDirty: true }); recalculateTotal(index, value) }} /></td>
          <td><Input aria-label={`Rate ${index + 1}`} type="number" min="0.000001" step="0.000001" value={row?.rate_per_kg ?? 0} onChange={(event) => { const value = Number(event.target.value); form.setValue(`items.${index}.rate_per_kg`, value, { shouldValidate: true, shouldDirty: true }); recalculateTotal(index, undefined, value) }} /></td>
          <td><Input aria-label={`Total cost ${index + 1}`} type="number" min="0.01" step="0.01" value={row?.total_cost ?? 0} onChange={(event) => { const total = Number(event.target.value); form.setValue(`items.${index}.total_cost`, total, { shouldValidate: true, shouldDirty: true }); const qty = numberValue(row?.quantity_kg); if (qty > 0) form.setValue(`items.${index}.rate_per_kg`, Math.round((total / qty) * 1_000_000) / 1_000_000, { shouldValidate: true, shouldDirty: true }) }} /></td>
          <td><Input aria-label={`Line notes ${index + 1}`} {...form.register(`items.${index}.notes`)} /></td>
          <td><button type="button" className="icon-button icon-button--danger" disabled={fields.fields.length <= 1} onClick={() => fields.remove(index)} aria-label={`Remove raw material ${index + 1}`}><Trash2 size={16} /></button></td>
        </tr>
      })}</tbody></table></TableWrap>
      {form.formState.errors.items?.message ? <span className="field__error" role="alert">{form.formState.errors.items.message}</span> : null}
      <div className="purchase-grand-total"><span>Consignment grand total</span><strong>{money(grandTotal)}</strong></div>
    </form>
  </Dialog>
}

export function BulkRmInvoiceDialog({ purchaseId, onClose }: { purchaseId: string | null; onClose: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState<'share' | 'print' | 'download' | null>(null)
  const purchaseQuery = useQuery({
    queryKey: ['rm-purchases', 'invoice', purchaseId],
    queryFn: ({ signal }) => api.get<RawMaterialPurchase>(`/rm-purchases/${purchaseId}`, undefined, signal),
    enabled: Boolean(purchaseId),
  })
  const companyQuery = useQuery({
    queryKey: ['company-profile'],
    queryFn: ({ signal }) => api.get<CompanyProfile>('/company-profile', undefined, signal),
    enabled: Boolean(purchaseId),
    staleTime: 60_000,
  })
  const purchase = purchaseQuery.data
  const company = companyQuery.data
  const purchaseItems = useMemo(
    () => purchase ? [...purchase.purchase_items].sort((left, right) => (left.line_no ?? Number.MAX_SAFE_INTEGER) - (right.line_no ?? Number.MAX_SAFE_INTEGER)) : [],
    [purchase],
  )
  const phone = normalizeWhatsAppPhone(purchase?.supplier_phone || company?.phone)
  const input = purchase && company ? { purchase, company } : null
  const share = async () => {
    if (!input) return
    setBusy('share')
    try {
      const result = await shareRawMaterialPurchaseInvoice(input)
      if (result === 'shared') toast.success('Invoice shared', 'The PDF was passed to your device share sheet. Choose WhatsApp and the intended contact.')
      else {
        if (phone) window.open(`https://wa.me/${phone}?text=${encodeURIComponent(rawMaterialPurchaseWhatsAppMessage(input.purchase))}`, '_blank', 'noopener,noreferrer')
        toast.success('Invoice PDF downloaded', phone ? 'WhatsApp opened to the supplier/owner. Attach the downloaded PDF.' : 'Attach the downloaded PDF in WhatsApp.')
      }
    } catch (error) {
      if ((error as DOMException)?.name !== 'AbortError') toast.error('Invoice not shared', error instanceof Error ? error.message : 'Try again.')
    } finally { setBusy(null) }
  }
  const download = async () => {
    if (!input) return
    setBusy('download')
    try { await downloadRawMaterialPurchaseInvoicePdf(input); toast.success('Invoice downloaded', `${input.purchase.invoice_no} was saved as a PDF.`) }
    catch (error) { toast.error('Invoice not downloaded', error instanceof Error ? error.message : 'Try again.') }
    finally { setBusy(null) }
  }
  const print = async () => {
    if (!input) return
    setBusy('print')
    try {
      if (!await printRawMaterialPurchaseInvoice(input)) toast.error('Print window blocked', 'Allow pop-ups for this site and try again.')
    } catch (error) {
      toast.error('Invoice not prepared', error instanceof Error ? error.message : 'Try again.')
    } finally { setBusy(null) }
  }
  const loading = purchaseQuery.isLoading || companyQuery.isLoading
  const error = purchaseQuery.error || companyQuery.error
  return <Dialog open={Boolean(purchaseId)} onClose={onClose} title={purchase ? `Invoice ${purchase.invoice_no}` : 'Raw-material purchase invoice'} description="Review, print, download, or share the saved supplier invoice." size="large" closeDisabled={Boolean(busy)} footer={<><Button variant="secondary" onClick={onClose} disabled={Boolean(busy)}>Close</Button><Button variant="secondary" icon={MessageCircle} loading={busy === 'share'} disabled={!input || Boolean(busy && busy !== 'share')} onClick={() => void share()}>WhatsApp</Button><Button variant="secondary" icon={Printer} loading={busy === 'print'} disabled={!input || Boolean(busy && busy !== 'print')} onClick={() => void print()}>Print</Button><Button icon={Download} loading={busy === 'download'} disabled={!input || Boolean(busy && busy !== 'download')} onClick={() => void download()}>Save PDF / Download</Button></>}>
    {loading ? <LoadingState label="Preparing raw-material invoice…" /> : error ? <ErrorState error={error} onRetry={() => { void purchaseQuery.refetch(); void companyQuery.refetch() }} /> : purchase && company ? <div className="rm-invoice-preview">
      <header className="rm-invoice-preview__head"><div className="rm-invoice-preview__brand">{company.logo_url ? <img src={company.logo_url} alt={`${company.name} logo`} /> : null}<div><h3>{company.name}</h3><p>{company.address || 'Address not configured'}</p><p>{[company.phone, company.email].filter(Boolean).join(' · ') || 'Contact details not configured'}</p></div></div><div><span>RAW MATERIAL PURCHASE INVOICE</span><strong className="mono">{purchase.invoice_no}</strong><p>{shortDate(purchase.purchase_date)}</p></div></header>
      <div className="rm-invoice-preview__meta"><div><span>Supplier</span><strong>{purchase.supplier_name || 'Not provided'}</strong><p>{purchase.supplier_phone || 'No supplier phone'}</p></div><div><span>Bill / Lorry No.</span><strong>{purchase.lorry_no || 'Not provided'}</strong><p className="mono">{purchase.reference_no}</p></div></div>
      <TableWrap><table><thead><tr><th>No.</th><th>Bulk RM type</th><th className="numeric">Qty (kg)</th><th className="numeric">Rate/kg</th><th className="numeric">Total</th></tr></thead><tbody>{purchaseItems.map((line, index) => <tr key={line.id}><td>{index + 1}</td><td><strong>{line.inventory_items?.name || line.material_name || 'Raw material'}</strong>{line.notes ? <span className="table-subtext">{line.notes}</span> : null}</td><td className="numeric">{quantity(line.quantity_kg, 3)}</td><td className="numeric">{money(line.rate_per_kg || numberValue(line.total_cost) / Math.max(numberValue(line.quantity_kg), 1))}</td><td className="numeric"><strong>{money(line.total_cost)}</strong></td></tr>)}</tbody></table></TableWrap>
      <div className="rm-invoice-preview__total"><span>Grand total</span><strong>{money(purchase.grand_total)}</strong></div>
      <footer className="rm-invoice-preview__footer"><div><span>Payment method</span><strong>{titleCase(purchase.payment_method)}</strong><p>{purchase.notes || 'No consignment notes'}</p><p><strong>Thank you for your business.</strong></p></div><div className="rm-invoice-preview__signature">Signature / Stamp</div></footer>
      {purchase.status === 'reversed' ? <InlineNotice tone="warning" title="Reversed invoice">This invoice is retained for audit history and should not be used as an active payment document.</InlineNotice> : null}
      {!phone ? <InlineNotice tone="warning" title="No WhatsApp number configured">Add the supplier phone on the purchase or the owner phone in the company profile. The share sheet can still send the PDF on supported devices.</InlineNotice> : null}
    </div> : <EmptyState message="The invoice record is unavailable." />}
  </Dialog>
}

export function BulkRmRateListEmpty({ onAdd }: { onAdd: () => void }) {
  return <EmptyState message="No Bulk RM rates are configured. Add the first effective rate before posting a purchase." action={<Button icon={Wrench} onClick={onAdd}>Add first rate</Button>} />
}
