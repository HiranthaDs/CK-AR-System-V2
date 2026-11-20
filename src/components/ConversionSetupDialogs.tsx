import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Tags, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod/v3'
import { api } from '../lib/api'
import { chipStockNameForConversion, CONVERSION_TYPE_OPTIONS, WORK_TYPE_OPTIONS } from '../lib/conversionSetup'
import { localIsoDate } from '../lib/format'
import type { ConversionType, MutationReceipt, PieceworkRate } from '../types/api'
import { Dialog } from './Dialog'
import { useToast } from './Toast'
import { Button, Field, Input, Select, Textarea } from './UI'

const conversionTypeSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2, 'Conversion type is required.').max(160),
  default_chip_name: z.string().trim().max(160).optional(),
  status: z.enum(['active', 'inactive']),
  notes: z.string().trim().max(1000).optional(),
})

const rateSchema = z.object({
  id: z.string().optional(),
  conversion_type_id: z.string().min(1, 'Conversion type is required.'),
  work_type: z.string().trim().min(2, 'Work type is required.').max(160),
  rate_per_kg: z.coerce.number().positive('Rate must be greater than zero.'),
  effective_from: z.string().min(1, 'Effective date is required.'),
  effective_to: z.string().optional(),
  status: z.enum(['active', 'inactive']),
  notes: z.string().trim().max(1000).optional(),
}).refine((value) => !value.effective_to || value.effective_to >= value.effective_from, {
  message: 'End date cannot be before start date.',
  path: ['effective_to'],
})

type ConversionTypeValues = z.infer<typeof conversionTypeSchema>
type RateValues = z.infer<typeof rateSchema>

async function invalidateConversionSetup(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['conversion-types'] }),
    queryClient.invalidateQueries({ queryKey: ['piecework-rates'] }),
    queryClient.invalidateQueries({ queryKey: ['lookup'] }),
  ])
}

export function ConversionTypeDialog({
  open,
  record,
  onClose,
}: {
  open: boolean
  record?: ConversionType | null | undefined
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [manualType, setManualType] = useState(false)
  const form = useForm<ConversionTypeValues>({
    resolver: zodResolver(conversionTypeSchema),
    values: {
      id: record?.id,
      name: record?.name ?? '',
      default_chip_name: record?.default_chip_name ?? chipStockNameForConversion(record?.name ?? ''),
      status: record?.status === 'inactive' ? 'inactive' : 'active',
      notes: record?.notes ?? '',
    },
  })
  useEffect(() => {
    if (!open) return
    setManualType(Boolean(record?.name && !CONVERSION_TYPE_OPTIONS.some((option) => option === record.name)))
  }, [open, record?.id, record?.name])
  const mutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Record<string, unknown> }) => id
      ? api.patch<MutationReceipt, Record<string, unknown>>(`/conversion-types/${id}`, body)
      : api.post<MutationReceipt, Record<string, unknown>>('/conversion-types', body),
    onSuccess: async () => {
      await invalidateConversionSetup(queryClient)
      toast.success('Conversion type saved', 'The type is ready to use in bulk-to-chip entries.')
      onClose()
    },
    onError: (error) => toast.error('Conversion type not saved', error.message),
  })
  const submit = form.handleSubmit(({ id, ...values }) => mutation.mutate({
    ...(id ? { id } : {}),
    body: {
      ...values,
      default_chip_name: values.default_chip_name || null,
      notes: values.notes || null,
    },
  }))
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={record ? 'Edit conversion type' : 'Add conversion type'}
      description="Saved types appear in the bulk-to-chip conversion dropdown."
      closeDisabled={mutation.isPending}
      footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={Tags} loading={mutation.isPending} onClick={() => void submit()}>Save type</Button></>}
    >
      <form className="form-grid form-grid--two" onSubmit={(event) => void submit(event)}>
        <Field label="Conversion type" required error={form.formState.errors.name?.message} hint="Choose a standard conversion or use Manual for another type.">
          <Select aria-label="Conversion type" value={manualType ? '__manual__' : form.watch('name')} onChange={(event) => {
            const value = event.target.value
            if (value === '__manual__') {
              setManualType(true)
              form.setValue('name', '', { shouldValidate: true })
              form.setValue('default_chip_name', '', { shouldValidate: true })
              return
            }
            setManualType(false)
            form.setValue('name', value, { shouldValidate: true })
            form.setValue('default_chip_name', chipStockNameForConversion(value), { shouldValidate: true })
          }}>
            <option value="">Select conversion type</option>
            {CONVERSION_TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
            <option value="__manual__">Manual — enter another type</option>
          </Select>
          {manualType ? <Input aria-label="Manual conversion type" value={form.watch('name')} onChange={(event) => {
            const value = event.target.value
            form.setValue('name', value, { shouldValidate: true })
            form.setValue('default_chip_name', chipStockNameForConversion(value), { shouldValidate: true })
          }} placeholder="Example: Nylon Bulk to Nylon Chip" autoFocus /> : null}
        </Field>
        <Field label="Default chip stock name" error={form.formState.errors.default_chip_name?.message} hint="Automatically derived from the selected or entered conversion type.">
          <Input {...form.register('default_chip_name')} placeholder="Select or enter a conversion type" readOnly />
        </Field>
        <Field label="Status">
          <Select {...form.register('status')}><option value="active">Active</option><option value="inactive">Inactive</option></Select>
        </Field>
        <Field label="Notes" error={form.formState.errors.notes?.message}>
          <Textarea rows={2} {...form.register('notes')} />
        </Field>
      </form>
    </Dialog>
  )
}

export function PieceworkRateDialog({
  open,
  record,
  onClose,
}: {
  open: boolean
  record?: PieceworkRate | null | undefined
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [manualWorkType, setManualWorkType] = useState(false)
  const typesQuery = useQuery({
    queryKey: ['conversion-types', 'rate-dialog'],
    queryFn: ({ signal }) => api.list<ConversionType>('/conversion-types', { page: 1, page_size: 100, status: 'active', descending: false }, signal),
    enabled: open,
    staleTime: 30_000,
  })
  const form = useForm<RateValues>({
    resolver: zodResolver(rateSchema),
    values: {
      id: record?.id,
      conversion_type_id: record?.conversion_type_id ?? '',
      work_type: record?.work_type ?? record?.type ?? '',
      rate_per_kg: Number(record?.rate_per_kg ?? 0),
      effective_from: record?.effective_from ?? localIsoDate(),
      effective_to: record?.effective_to ?? '',
      status: record?.status === 'inactive' ? 'inactive' : 'active',
      notes: record?.notes ?? '',
    },
  })
  useEffect(() => {
    if (!open) return
    const workType = record?.work_type ?? record?.type ?? ''
    setManualWorkType(Boolean(workType && !WORK_TYPE_OPTIONS.some((option) => option === workType)))
  }, [open, record?.id, record?.type, record?.work_type])
  const selectedTypeId = form.watch('conversion_type_id') ?? ''
  const types = typesQuery.data?.items ?? []
  const mutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Record<string, unknown> }) => id
      ? api.patch<MutationReceipt, Record<string, unknown>>(`/piecework-rates/${id}`, body)
      : api.post<MutationReceipt, Record<string, unknown>>('/piecework-rates', body),
    onSuccess: async () => {
      await invalidateConversionSetup(queryClient)
      toast.success('Conversion rate saved', 'The effective-dated rate is ready for worker allocation.')
      onClose()
    },
    onError: (error) => toast.error('Conversion rate not saved', error.message),
  })
  const submit = form.handleSubmit(({ id, ...values }) => mutation.mutate({
    ...(id ? { id } : {}),
    body: {
      ...values,
      conversion_type_id: values.conversion_type_id || null,
      effective_to: values.effective_to || null,
      notes: values.notes || null,
    },
  }))
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={record ? 'Edit conversion rate' : 'Add conversion rate'}
      description="Link a work rate to a saved conversion type."
      closeDisabled={mutation.isPending}
      footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={Wrench} loading={mutation.isPending} onClick={() => void submit()}>Save rate</Button></>}
    >
      <form className="form-grid form-grid--two" onSubmit={(event) => void submit(event)}>
        <Field label="Conversion type" required error={form.formState.errors.conversion_type_id?.message} hint={typesQuery.isError ? 'Saved conversion types could not be loaded. Try again.' : undefined}>
          <Select
            aria-label="Rate conversion type"
            value={selectedTypeId}
            onChange={(event) => {
              const value = event.target.value
              form.setValue('conversion_type_id', value, { shouldValidate: true })
              if (value) {
                setManualWorkType(false)
                form.setValue('work_type', 'Grinding', { shouldValidate: true })
              }
            }}
          >
            <option value="">Select saved conversion type</option>
            {typesQuery.isLoading ? <option value="" disabled>Loading saved types…</option> : null}
            {types.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </Field>
        <Field label="Work type" required error={form.formState.errors.work_type?.message} hint="Defaults to Grinding; choose another option or use Manual.">
          <Select aria-label="Work type" value={manualWorkType ? '__manual__' : form.watch('work_type')} onChange={(event) => {
            const value = event.target.value
            if (value === '__manual__') {
              setManualWorkType(true)
              form.setValue('work_type', '', { shouldValidate: true })
              return
            }
            setManualWorkType(false)
            form.setValue('work_type', value, { shouldValidate: true })
          }}>
            <option value="">Select work type</option>
            {WORK_TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
            <option value="__manual__">Manual — enter another work type</option>
          </Select>
          {manualWorkType ? <Input aria-label="Manual work type" value={form.watch('work_type')} onChange={(event) => form.setValue('work_type', event.target.value, { shouldValidate: true })} placeholder="Enter work type" autoFocus /> : null}
        </Field>
        <Field label="Rate per kg" required error={form.formState.errors.rate_per_kg?.message}>
          <Input type="number" min="0.01" step="0.01" {...form.register('rate_per_kg')} />
        </Field>
        <Field label="Effective from" required error={form.formState.errors.effective_from?.message}>
          <Input type="date" {...form.register('effective_from')} />
        </Field>
        <Field label="Effective to" error={form.formState.errors.effective_to?.message}>
          <Input type="date" {...form.register('effective_to')} />
        </Field>
        <Field label="Status">
          <Select {...form.register('status')}><option value="active">Active</option><option value="inactive">Inactive</option></Select>
        </Field>
        <Field label="Notes" className="field--span-2" error={form.formState.errors.notes?.message}>
          <Textarea rows={2} {...form.register('notes')} />
        </Field>
      </form>
    </Dialog>
  )
}
