import { zodResolver } from '@hookform/resolvers/zod'
import type { UseMutationResult } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { Boxes, Factory, ImagePlus, PackageOpen, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { z } from 'zod/v3'
import { supabase } from '../lib/supabase'
import { money, numberValue } from '../lib/format'
import type { InventoryItem, MutationReceipt } from '../types/api'
import { Dialog } from './Dialog'
import { Badge, Button, Field, Input, Select, Textarea } from './UI'

export const PRODUCT_CATEGORIES = ['Frame Stand', 'Head Clip'] as const

export const productSchema = z.object({
  sku: z.string().max(80).optional(),
  name: z.string().min(2, 'Product name is required.').max(160),
  product_type: z.string().min(1, 'Category is required.').max(100),
  selling_price: z.coerce.number().positive('Selling price must be greater than zero.'),
  image_url: z.string().url('Product image URL is invalid.').max(1000).or(z.literal('')),
  description: z.string().max(500, 'Use no more than 500 characters.'),
  is_active: z.boolean(),
})

export type ProductValues = z.infer<typeof productSchema>
export type ProductMutationInput = { id?: string; body: ProductValues }

const acceptedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const maxImageSize = 5 * 1024 * 1024

function storagePath(url: string | null | undefined) {
  if (!url) return null
  const marker = '/storage/v1/object/public/product-images/'
  const index = url.indexOf(marker)
  if (index < 0) return null
  return decodeURIComponent(url.slice(index + marker.length))
}

async function uploadProductImage(file: File) {
  if (!acceptedImageTypes.has(file.type)) throw new Error('Use a JPG, PNG, or WebP product image.')
  if (file.size > maxImageSize) throw new Error('Product images must be 5 MB or smaller.')
  const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
  const fileName = `products/${crypto.randomUUID()}.${extension}`
  const { error } = await supabase.storage.from('product-images').upload(fileName, file, {
    cacheControl: '3600',
    contentType: file.type,
    upsert: false,
  })
  if (error) throw new Error(error.message)
  return {
    path: fileName,
    url: supabase.storage.from('product-images').getPublicUrl(fileName).data.publicUrl,
  }
}

export function ProductDialog({ open, record, mutation, onClose }: {
  open: boolean
  record: InventoryItem | null
  mutation: UseMutationResult<MutationReceipt, Error, ProductMutationInput>
  onClose: () => void
}) {
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [manualCategory, setManualCategory] = useState(() => {
    const current = record?.product_type ?? ''
    return Boolean(current && !PRODUCT_CATEGORIES.includes(current as typeof PRODUCT_CATEGORIES[number]))
  })
  const imagePreview = useMemo(() => imageFile ? URL.createObjectURL(imageFile) : '', [imageFile])
  const form = useForm<ProductValues>({
    resolver: zodResolver(productSchema),
    values: {
      sku: record?.sku ?? '',
      name: record?.name ?? '',
      product_type: record?.product_type ?? '',
      selling_price: numberValue(record?.selling_price),
      image_url: record?.image_url ?? '',
      description: record?.description ?? '',
      is_active: record?.is_active ?? true,
    },
  })
  const description = useWatch({ control: form.control, name: 'description' })
  const savedImageUrl = useWatch({ control: form.control, name: 'image_url' })

  useEffect(() => () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview)
  }, [imagePreview])

  const currentImage = imagePreview || savedImageUrl
  const submit = form.handleSubmit(async (values) => {
    setImageError(null)
    let uploaded: { path: string; url: string } | null = null
    let productSaved = false
    try {
      uploaded = imageFile ? await uploadProductImage(imageFile) : null
      const body = {
        ...values,
        sku: values.sku || undefined,
        image_url: uploaded?.url ?? values.image_url,
        description: values.description.trim(),
      }
      await mutation.mutateAsync({ ...(record ? { id: record.id } : {}), body })
      productSaved = true
      const oldPath = storagePath(record?.image_url)
      if (oldPath && record?.image_url !== body.image_url) {
        await supabase.storage.from('product-images').remove([oldPath])
      }
    } catch (error) {
      if (uploaded && !productSaved) await supabase.storage.from('product-images').remove([uploaded.path])
      setImageError(error instanceof Error ? error.message : 'The product image could not be saved.')
    }
  })

  return <Dialog
    open={open}
    onClose={onClose}
    title={record ? 'Edit product' : 'Add product'}
    description="Create a customer-ready product once, then reuse it in production, quotations, invoices, and the order portal."
    size="wide"
    closeDisabled={mutation.isPending}
    footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={Boxes} loading={mutation.isPending} onClick={() => void submit()}>Save product</Button></>}
  >
    <form className="product-editor" onSubmit={(event) => void submit(event)}>
      <div className="product-editor__image">
        <div className="product-image-preview">
          {currentImage ? <img src={currentImage} alt="Product preview" /> : <div><ImagePlus size={34} /><span>Add a clear product photo</span></div>}
        </div>
        <label className="button button--secondary product-image-button">
          <ImagePlus size={17} /> {currentImage ? 'Replace image' : 'Choose image'}
          <input
            className="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple={false}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              setImageError(null)
              if (file && !acceptedImageTypes.has(file.type)) { setImageError('Use a JPG, PNG, or WebP product image.'); event.currentTarget.value = ''; return }
              if (file && file.size > maxImageSize) { setImageError('Product images must be 5 MB or smaller.'); event.currentTarget.value = ''; return }
              setImageFile(file)
              event.currentTarget.value = ''
            }}
          />
        </label>
        {currentImage ? <Button type="button" size="small" variant="ghost" icon={Trash2} onClick={() => { setImageFile(null); form.setValue('image_url', '') }}>Remove image</Button> : null}
        {imageFile ? <small className="product-image-filename" title={imageFile.name}>Selected: {imageFile.name}</small> : null}
        <small>One image only · JPG, PNG, or WebP · maximum 5 MB</small>
        {imageError ? <span className="field__error" role="alert">{imageError}</span> : null}
      </div>

      <div className="form-grid form-grid--two product-editor__fields">
        <Controller control={form.control} name="product_type" render={({ field }) => <Field label="Category" required hint="Choose a common category or enter your own." error={form.formState.errors.product_type?.message}>
          <div className="category-composer">
            <Select value={manualCategory ? '__manual__' : field.value} onChange={(event) => {
              const value = event.target.value
              if (value === '__manual__') { setManualCategory(true); field.onChange('') }
              else { setManualCategory(false); field.onChange(value) }
            }}>
              <option value="">Select category</option>
              {PRODUCT_CATEGORIES.map((category) => <option value={category} key={category}>{category}</option>)}
              <option value="__manual__">Type (manual entry)</option>
            </Select>
            {manualCategory ? <Input value={field.value} maxLength={100} autoFocus placeholder="Type a category" onChange={field.onChange} /> : null}
          </div>
        </Field>} />
        <Field label="Product name" required error={form.formState.errors.name?.message}><Input {...form.register('name')} placeholder="Example: Large black frame stand" /></Field>
        <Field label="Selling price" required hint="Shown in quotations and the customer portal." error={form.formState.errors.selling_price?.message}><Input type="number" min="0.01" step="0.01" {...form.register('selling_price')} /></Field>
        <Field label="SKU" hint="Leave blank to create one automatically."><Input {...form.register('sku')} placeholder="Automatic" /></Field>
        <Field label="Short description" className="field--span-2" hint={`Help customers understand size, finish, colour, or other useful details. ${description.length}/500`} error={form.formState.errors.description?.message}><Textarea rows={4} maxLength={500} {...form.register('description')} placeholder="Describe this product…" /></Field>
        <Field label="Availability"><label className="checkbox-line"><input type="checkbox" {...form.register('is_active')} /><span>Active and visible in the customer catalogue</span></label></Field>
      </div>
    </form>
  </Dialog>
}

export function ProductCards({ products, onEdit, onReverse, onProduce }: {
  products: InventoryItem[]
  onEdit: (product: InventoryItem) => void
  onReverse: (product: InventoryItem) => void
  onProduce?: (product: InventoryItem) => void
}) {
  return <div className="product-admin-grid">{products.map((product) => <article className={`product-admin-card${product.is_active ? '' : ' product-admin-card--inactive'}`} key={product.id}>
    <div className="product-admin-card__image">
      {product.image_url ? <img src={product.image_url} alt={product.name} loading="lazy" /> : <PackageOpen size={32} aria-hidden="true" />}
      <Badge tone={product.is_active ? 'success' : 'neutral'}>{product.is_active ? 'Active' : 'Reversed'}</Badge>
    </div>
    <div className="product-admin-card__body">
      <div><span className="eyebrow">{product.product_type || 'Uncategorized'}</span><h3>{product.name}</h3><span className="mono product-admin-card__sku">{product.sku || 'Auto SKU'}</span></div>
      <p>{product.description || 'No description has been added yet.'}</p>
      <strong className="product-admin-card__price">{money(product.selling_price)}</strong>
    </div>
    <div className="product-admin-card__actions">
      {onProduce ? <Button variant="ghost" size="small" icon={Factory} disabled={!product.is_active} onClick={() => onProduce(product)}>Produce</Button> : null}
      <Button variant="ghost" size="small" icon={Pencil} onClick={() => onEdit(product)}>Edit</Button>
      <Button variant="ghost" size="small" icon={RotateCcw} disabled={!product.is_active} onClick={() => onReverse(product)}>Reverse</Button>
    </div>
  </article>)}</div>
}
