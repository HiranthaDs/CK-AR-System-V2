import type { ComponentPropsWithoutRef } from 'react'
import { BRAND_LOGO_URL } from '../lib/brand'

export function BrandLogo({ alt = 'CK Plastic', ...props }: ComponentPropsWithoutRef<'img'>) {
  return <img src={BRAND_LOGO_URL} alt={alt} draggable={false} {...props} />
}
