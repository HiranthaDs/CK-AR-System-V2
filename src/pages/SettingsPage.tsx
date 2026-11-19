import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, BookOpen, Boxes, Copy, Database, ExternalLink, KeyRound, LockKeyhole, Pencil, Plus, RefreshCw, Save, ShieldCheck, Tags, Trash2, UserPlus, Wrench, type LucideIcon } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { ConversionTypeDialog, PieceworkRateDialog } from '../components/ConversionSetupDialogs'
import { ProductCards, ProductDialog, type ProductValues } from '../components/ProductSetup'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, EmptyState, ErrorState, Field, InlineNotice, Input, LoadingState, PageHeader, SectionTitle, TableWrap } from '../components/UI'
import { api, ApiError } from '../lib/api'
import { buildWebsiteCatalogSnippet, buildWebsiteCatalogUrl } from '../lib/catalogApi'
import { money, shortDate, titleCase } from '../lib/format'
import { supabaseProjectUrl } from '../lib/supabase'
import type { AdminUserAccess, CatalogApiCredentialResponse, CatalogApiKeyReceipt, CompanyProfile, ConversionType, InventoryItem, MutationReceipt, PieceworkRate } from '../types/api'
import { useAppContext } from '../layout/AppShell'

export const PURGE_CONFIRMATION = 'DELETE ALL BUSINESS DATA'
const CATALOG_DETAILS_PASSWORD = '112113'

type CompanyAccessChoice = 'CK' | 'AR' | 'BOTH'
type AccessRole = 'admin' | 'accountant' | 'operations' | 'payroll' | 'viewer'
type CreateUserField = 'display_name' | 'email' | 'temporary_password' | 'role_codes'

interface NewUserDraft {
  display_name: string
  email: string
  temporary_password: string
  company_access: CompanyAccessChoice
  role_codes: AccessRole[]
  is_super_admin: boolean
}

function validateNewUser(value: NewUserDraft) {
  const errors: Partial<Record<CreateUserField, string>> = {}
  const email = value.email.trim()
  const password = value.temporary_password

  if (!value.display_name.trim()) errors.display_name = 'Enter the user’s full name.'
  else if (value.display_name.trim().length > 200) errors.display_name = 'Use no more than 200 characters.'

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.'

  if (password.length < 10) errors.temporary_password = 'Use at least 10 characters.'
  else if (password.length > 72) errors.temporary_password = 'Use no more than 72 characters.'
  else if (!/[a-z]/.test(password)) errors.temporary_password = 'Include a lowercase letter.'
  else if (!/[A-Z]/.test(password)) errors.temporary_password = 'Include an uppercase letter.'
  else if (!/[0-9]/.test(password)) errors.temporary_password = 'Include a number.'
  else if (!/[^A-Za-z0-9]/.test(password)) errors.temporary_password = 'Include a symbol.'

  if (!value.is_super_admin && value.role_codes.length === 0) {
    errors.role_codes = 'Select at least one capability access role.'
  }
  return errors
}

const accessRoleOptions: Array<{ code: AccessRole; label: string; description: string }> = [
  { code: 'admin', label: 'Company administrator', description: 'All company pages, actions, setup, audit, and access management.' },
  { code: 'accountant', label: 'Accounting & PDF Studio', description: 'Accounting, financial reports, PDF Studio, settlements, and payroll review.' },
  { code: 'operations', label: 'Production & operations', description: 'Purchases, conversion, production, inventory, sales, and operational reports.' },
  { code: 'payroll', label: 'Staff & payroll', description: 'Employee records, work, overtime, payroll processing, and payroll reports.' },
  { code: 'viewer', label: 'Read only', description: 'View operational and financial pages without posting or editing.' },
]

interface PurgePayload {
  confirmation: typeof PURGE_CONFIRMATION
  acknowledge_irreversible: true
  delete_conversion_rates: true
  company_code: 'CK' | 'AR'
}

interface AccountSummary {
  user_id: string
  display_name: string | null
  email: string | null
  profile_active: boolean
  is_super_admin: boolean
  company_access: Array<{ code: string; roles: string[] }>
}

function summarizeAccounts(rows: AdminUserAccess[]): AccountSummary[] {
  const accounts = new Map<string, AccountSummary>()
  for (const row of rows) {
    let account = accounts.get(row.user_id)
    if (!account) {
      account = {
        user_id: row.user_id,
        display_name: row.display_name ?? null,
        email: row.email ?? null,
        profile_active: row.profile_active,
        is_super_admin: row.is_super_admin,
        company_access: [],
      }
    }
    if (row.membership_active) {
      account.company_access.push({ code: row.company_code, roles: row.role_codes })
    }
    accounts.set(row.user_id, account)
  }
  return [...accounts.values()].sort((left, right) =>
    (left.display_name || left.email || '').localeCompare(right.display_name || right.email || ''),
  )
}

const deletedGroups = [
  'This company’s employee, bank/pay, compensation, work, and payroll records',
  'This company’s complete production, conversion, purchasing, inventory position, and stock-movement data',
  'This company’s sales, receipts, receivables, journals, and accounting transactions',
  'All saved conversion rates (shared by CK and AR)',
]

const preservedGroups = [
  'All Supabase Authentication accounts, user profiles, memberships, and capability roles',
  'The complete Activity & audit history, including the new purge receipt',
  'Every business record belonging only to the other company',
  'Shared inventory item definitions, conversion types, and chart of accounts',
  'Database schema, fiscal controls, and application configuration',
]

const externalGroups = [
  'Supabase backups and point-in-time recovery history',
  'PDFs already downloaded, printed, emailed, or stored on another device or service',
  'Any third-party exports or copies outside this live ERP database',
]

const workflowGuideSteps = [
  {
    englishTitle: 'Confirm the company and year',
    path: '/dashboard',
    englishBody: 'Sign in through the correct CK or AR portal. Before entering anything, check the company name and financial year shown at the top. CK and AR records stay separate.',
    sinhalaTitle: 'සමාගම සහ වර්ෂය තහවුරු කරන්න',
    sinhalaBody: 'නිවැරදි CK හෝ AR පිවිසුම් ද්වාරයෙන් ඇතුළුවන්න. කිසිවක් ඇතුළත් කිරීමට පෙර ඉහළින් පෙන්වන සමාගමේ නම සහ මූල්‍ය වර්ෂය පරීක්ෂා කරන්න. CK සහ AR වාර්තා වෙන වෙනම පවත්වා ගනී.',
  },
  {
    englishTitle: 'Complete the initial setup',
    path: '/settings',
    englishBody: 'A super administrator first creates each login and chooses CK, AR, or both plus capability access. A company administrator then maintains conversion types and piecework rates. The menu shows only authorized workspaces, and the API/database enforce the same rules.',
    sinhalaTitle: 'මූලික සැකසුම් සම්පූර්ණ කරන්න',
    sinhalaBody: 'මෙහෙයුම් සටහන් කිරීමට පෙර Settings පිටුවෙන් සමාගමේ පරිවර්තන වර්ග සහ කෑලි වැඩ අනුපාත සකස් කරන්න. පිවිසුණු සෑම පරිශීලකයෙකුටම CK සහ AR ද්වාර දෙකේම සියලු මෙවලම් භාවිත කළ හැක.',
  },
  {
    englishTitle: 'Record raw-material purchases',
    path: '/production',
    englishBody: 'In Production, enter each raw-material purchase with its supplier, quantity, cost, and payment method. Saving it updates bulk stock and accounting together.',
    sinhalaTitle: 'අමුද්‍රව්‍ය මිලදී ගැනීම් සටහන් කරන්න',
    sinhalaBody: 'Production පිටුවේ සෑම අමුද්‍රව්‍ය මිලදී ගැනීමක්ම සැපයුම්කරු, ප්‍රමාණය, පිරිවැය සහ ගෙවීම් ක්‍රමය සමඟ ඇතුළත් කරන්න. එය සුරැකූ විට තොග අමුද්‍රව්‍ය සහ ගිණුම් වාර්තා එකවර යාවත්කාලීන වේ.',
  },
  {
    englishTitle: 'Convert material and record production',
    path: '/production',
    englishBody: 'Post conversions to move bulk material into chip stock and include the correct workers and rates. Then record production runs to turn chip stock into finished goods. Check all quantities before saving.',
    sinhalaTitle: 'ද්‍රව්‍ය පරිවර්තනය කර නිෂ්පාදනය සටහන් කරන්න',
    sinhalaBody: 'තොග අමුද්‍රව්‍ය චිප් තොගයට මාරු කිරීමට පරිවර්තන සටහන් කර නිවැරදි සේවකයින් සහ අනුපාත ඇතුළත් කරන්න. ඉන්පසු චිප් තොගය නිමි භාණ්ඩ බවට පත් කිරීමට නිෂ්පාදන වාර සටහන් කරන්න. සුරැකීමට පෙර සියලු ප්‍රමාණ පරීක්ෂා කරන්න.',
  },
  {
    englishTitle: 'Check inventory before selling',
    path: '/inventory',
    englishBody: 'Review the Bulk, Chip, and Finished views in Inventory after every operation. If a posted record is wrong, use the available correction or reversal control instead of entering it again.',
    sinhalaTitle: 'විකිණීමට පෙර තොග පරීක්ෂා කරන්න',
    sinhalaBody: 'සෑම මෙහෙයුමකටම පසු Inventory පිටුවේ Bulk, Chip සහ Finished දසුන් පරීක්ෂා කරන්න. සුරැකූ වාර්තාවක් වැරදි නම් එය නැවත ඇතුළත් නොකර, තිබෙන නිවැරදි කිරීමේ හෝ අවලංගු කිරීමේ ක්‍රියාව භාවිතා කරන්න.',
  },
  {
    englishTitle: 'Create sales and record receipts',
    path: '/sales',
    englishBody: 'Create an invoice in Sales using available finished stock. When money is actually received, post the receipt against the correct invoice and confirm the remaining balance.',
    sinhalaTitle: 'විකුණුම් සහ ලැබීම් සටහන් කරන්න',
    sinhalaBody: 'පවතින නිමි භාණ්ඩ තොගය භාවිතා කර Sales පිටුවෙන් ඉන්වොයිසියක් සාදන්න. මුදල් සැබවින්ම ලැබුණු පසු නිවැරදි ඉන්වොයිසියට ලැබීම සටහන් කර ඉතිරි ශේෂය තහවුරු කරන්න.',
  },
  {
    englishTitle: 'Process employee work and payroll',
    path: '/employees',
    englishBody: 'Keep employee details, work, overtime, and piecework current. Review open earnings before creating payroll, and record a payroll payment only after the payment is made.',
    sinhalaTitle: 'සේවක වැඩ සහ වැටුප් සකසන්න',
    sinhalaBody: 'සේවක විස්තර, වැඩ, අතිකාල සහ කෑලි වැඩ වාර්තා යාවත්කාලීනව තබා ගන්න. වැටුප් සැකසීමට පෙර විවෘත ඉපැයීම් පරීක්ෂා කර, ගෙවීම සිදු කළ පසුව පමණක් වැටුප් ගෙවීම සටහන් කරන්න.',
  },
  {
    englishTitle: 'Review accounting and finish safely',
    path: '/accounting',
    englishBody: 'Use Accounting to review automatic entries, ledgers, reports, and PDF Studio. Quick double-entry remains the safest option for normal cash and bank entries. The Universal journal can use any chart account for a genuine correction; review the protected-account warning, verify the supporting records, and confirm before saving. Every journal must balance. Reconcile the ledger, review the Dashboard, and sign out.',
    sinhalaTitle: 'ගිණුම් පරීක්ෂා කර ආරක්ෂිතව අවසන් කරන්න',
    sinhalaBody: 'ස්වයංක්‍රීයව සටහන් වූ ගනුදෙනු, ලෙජර සහ වාර්තා පරීක්ෂා කිරීමට Accounting භාවිතා කරන්න. සැබෑ ගැලපීමක් සඳහා පමණක් අතින් ජර්නල් සටහනක් එක් කරන්න. දවස අවසානයේ Dashboard පරීක්ෂා කර අනතුරු ඇඟවීම් විසඳා පද්ධතියෙන් ඉවත් වන්න.',
  },
] as const

export function SettingsPage() {
  const { basePath, me } = useAppContext()
  const [guideOpen, setGuideOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [typeDialogOpen, setTypeDialogOpen] = useState(false)
  const [rateDialogOpen, setRateDialogOpen] = useState(false)
  const [editingType, setEditingType] = useState<ConversionType | null>(null)
  const [editingRate, setEditingRate] = useState<PieceworkRate | null>(null)
  const [productOpen, setProductOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<InventoryItem | null>(null)
  const [reversingProduct, setReversingProduct] = useState<InventoryItem | null>(null)
  const [catalogAction, setCatalogAction] = useState<{ companyId: string; action: 'rotate' | 'revoke' } | null>(null)
  const [newCatalogLink, setNewCatalogLink] = useState<{ companyId: string; apiId: string } | null>(null)
  const [catalogUnlockCompanyId, setCatalogUnlockCompanyId] = useState<string | null>(null)
  const [catalogPassword, setCatalogPassword] = useState('')
  const [catalogPasswordError, setCatalogPasswordError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [createUserOpen, setCreateUserOpen] = useState(false)
  const [accountToRemove, setAccountToRemove] = useState<AccountSummary | null>(null)
  const [removalPin, setRemovalPin] = useState('')
  const [newUser, setNewUser] = useState<NewUserDraft>({
    display_name: '',
    email: '',
    temporary_password: '',
    company_access: 'BOTH' as CompanyAccessChoice,
    role_codes: ['viewer'] as AccessRole[],
    is_super_admin: false,
  })
  const [companyDraft, setCompanyDraft] = useState<{ address: string; phone: string; email: string; logo_url: string } | null>(null)
  const [createUserErrors, setCreateUserErrors] = useState<Partial<Record<CreateUserField, string>>>({})
  const [createUserSubmissionError, setCreateUserSubmissionError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()

  const clearCreateUserError = (field: CreateUserField) => {
    setCreateUserSubmissionError(null)
    setCreateUserErrors((value) => {
      const next = { ...value }
      delete next[field]
      return next
    })
  }

  const typesQuery = useQuery({
    queryKey: ['conversion-types', 'settings'],
    queryFn: ({ signal }) => api.list<ConversionType>('/conversion-types', { page: 1, page_size: 100, descending: false }, signal),
  })
  const companyProfileQuery = useQuery({
    queryKey: ['company-profile', me.active_company_id],
    queryFn: ({ signal }) => api.get<CompanyProfile>('/company-profile', undefined, signal),
  })
  const effectiveCompanyDraft = companyDraft ?? {
    address: companyProfileQuery.data?.address ?? '',
    phone: companyProfileQuery.data?.phone ?? '',
    email: companyProfileQuery.data?.email ?? '',
    logo_url: companyProfileQuery.data?.logo_url ?? '',
  }
  const companyProfileMutation = useMutation({
    mutationFn: () => api.patch<MutationReceipt, typeof effectiveCompanyDraft>('/company-profile', effectiveCompanyDraft),
    onSuccess: async () => {
      setCompanyDraft(null)
      await queryClient.invalidateQueries({ queryKey: ['company-profile'] })
      toast.success('Company invoice details saved', 'New raw-material purchase invoices will use these details automatically.')
    },
    onError: (error) => toast.error('Company details were not saved', error instanceof Error ? error.message : 'Try again.'),
  })
  const ratesQuery = useQuery({
    queryKey: ['piecework-rates', 'settings'],
    queryFn: ({ signal }) => api.list<PieceworkRate>('/piecework-rates', { page: 1, page_size: 100, descending: false }, signal),
  })
  const productsQuery = useQuery({
    queryKey: ['products', 'settings'],
    queryFn: ({ signal }) => api.list<InventoryItem>('/products', { page: 1, page_size: 100, descending: false }, signal),
  })
  const catalogCredentialQuery = useQuery({
    queryKey: ['catalog-api-credential', me.active_company_id],
    queryFn: ({ signal }) => api.get<CatalogApiCredentialResponse>('/catalog-api-credential', undefined, signal),
    enabled: me.permission_codes.includes('system.admin'),
  })
  const usersQuery = useQuery({
    queryKey: ['admin-users', me.active_company_id],
    queryFn: ({ signal }) => api.list<AdminUserAccess>('/admin/users', { page: 1, page_size: 100 }, signal),
    enabled: me.is_super_admin,
  })
  const createUserMutation = useMutation({
    mutationFn: (payload: NewUserDraft) => api.post<MutationReceipt, NewUserDraft>('/admin/users', payload),
    onSuccess: async () => {
      setCreateUserOpen(false)
      setNewUser({ display_name: '', email: '', temporary_password: '', company_access: 'BOTH', role_codes: ['viewer'], is_super_admin: false })
      setCreateUserErrors({})
      setCreateUserSubmissionError(null)
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      toast.success('Account created', 'The user can sign in with the temporary password and only the selected access.')
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Review the account and try again.'
      setCreateUserSubmissionError(message)
      toast.error('Account was not created', message)
    },
  })

  const productMutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: ProductValues }) => id
      ? api.patch<MutationReceipt, ProductValues>(`/products/${id}`, body)
      : api.post<MutationReceipt, ProductValues>('/products', body),
    onSuccess: async () => {
      setProductOpen(false)
      setEditingProduct(null)
      await queryClient.invalidateQueries({ queryKey: ['products'] })
      toast.success('Product saved', 'The product is available in production, sales, and the customer order portal.')
    },
    onError: (error) => toast.error('Product was not saved', error instanceof Error ? error.message : 'Try again.'),
  })
  const reverseProductMutation = useMutation({
    mutationFn: (product: InventoryItem) => api.delete<MutationReceipt>(`/products/${product.id}`),
    onSuccess: async () => {
      setReversingProduct(null)
      await queryClient.invalidateQueries({ queryKey: ['products'] })
      toast.success('Product reversed', 'It is hidden from the customer catalogue and new transactions.')
    },
    onError: (error) => toast.error('Product could not be reversed', error instanceof Error ? error.message : 'Try again.'),
  })
  const rotateCatalogKeyMutation = useMutation({
    mutationFn: () => api.post<CatalogApiKeyReceipt, Record<string, never>>('/catalog-api-credential/rotate', {}),
    onSuccess: async (result) => {
      setCatalogAction(null)
      setNewCatalogLink({ companyId: me.active_company_id, apiId: result.api_id })
      await queryClient.invalidateQueries({ queryKey: ['catalog-api-credential'] })
      toast.success('Live website API ready', 'Copy the public URL or JavaScript example into any website. No website backend or secret key is required.')
    },
    onError: (error) => toast.error('Website API link was not created', error instanceof Error ? error.message : 'Try again.'),
  })
  const revokeCatalogKeyMutation = useMutation({
    mutationFn: () => api.delete<MutationReceipt>('/catalog-api-credential'),
    onSuccess: async () => {
      setCatalogAction(null)
      setNewCatalogLink(null)
      await queryClient.invalidateQueries({ queryKey: ['catalog-api-credential'] })
      toast.success('Website API disabled', 'The shared URL will stop returning catalogue data immediately.')
    },
    onError: (error) => toast.error('Website API was not disabled', error instanceof Error ? error.message : 'Try again.'),
  })

  const submitNewUser = () => {
    setCreateUserSubmissionError(null)
    const errors = validateNewUser(newUser)
    setCreateUserErrors(errors)
    if (Object.keys(errors).length) return
    createUserMutation.mutate({
      ...newUser,
      display_name: newUser.display_name.trim(),
      email: newUser.email.trim().toLowerCase(),
      role_codes: [...new Set(newUser.role_codes)],
    })
  }

  const statusMutation = useMutation({
    mutationFn: ({ account, isActive }: { account: AccountSummary; isActive: boolean }) =>
      api.patch<MutationReceipt, { is_active: boolean }>(`/admin/users/${account.user_id}/status`, { is_active: isActive }),
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      toast.success(
        variables.isActive ? 'Account activated' : 'Account deactivated',
        variables.isActive
          ? 'The user can use their assigned CK/AR access again.'
          : 'Existing sessions can no longer access ERP data.',
      )
    },
    onError: (error) => toast.error('Status was not changed', error instanceof Error ? error.message : 'Try again.'),
  })

  const removeAccountMutation = useMutation({
    mutationFn: (account: AccountSummary) =>
      api.delete<MutationReceipt, { confirmation_pin: string }>(`/admin/users/${account.user_id}`, { confirmation_pin: removalPin }),
    onSuccess: async () => {
      setAccountToRemove(null)
      setRemovalPin('')
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      toast.success('Account removed', 'Login access was disabled and removed from the access list. Historical audit references were preserved.')
    },
    onError: (error) => toast.error('Account was not removed', error instanceof Error ? error.message : 'Check the PIN and try again.'),
  })

  const purgeMutation = useMutation({
    mutationFn: () => api.post<MutationReceipt, PurgePayload>('/admin/purge-business-data', {
      confirmation: PURGE_CONFIRMATION,
      acknowledge_irreversible: true,
      delete_conversion_rates: true,
      company_code: me.active_company_code === 'AR' ? 'AR' : 'CK',
    }),
    onSuccess: async () => {
      setDialogOpen(false)
      setConfirmation('')
      setAcknowledged(false)
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'me',
      })
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      toast.success(
        'Business data deleted',
        `${me.active_company_code} business records and all saved conversion rates were deleted. Login accounts, audit history, and the other company were preserved.`,
      )
      void navigate(`${basePath}/dashboard`, { replace: true })
    },
    onError: (error) => {
      toast.error(
        'Nothing was deleted',
        error instanceof Error ? error.message : 'The purge could not be completed.',
      )
    },
  })

  const closeDialog = () => {
    if (purgeMutation.isPending) return
    setDialogOpen(false)
    setConfirmation('')
    setAcknowledged(false)
  }

  const confirmationMatches = confirmation === PURGE_CONFIRMATION
  const canPurge = confirmationMatches && acknowledged && !purgeMutation.isPending
  const removalPinComplete = removalPin.length === 4
  const conversionTypes = typesQuery.data?.items ?? []
  const rates = ratesQuery.data?.items ?? []
  const accounts = summarizeAccounts(usersQuery.data?.items ?? [])
  const typeNames = new Map(conversionTypes.map((item) => [item.id, item.name]))
  const closeTypeDialog = () => { setTypeDialogOpen(false); setEditingType(null) }
  const closeRateDialog = () => { setRateDialogOpen(false); setEditingRate(null) }
  const catalogueLink = `${window.location.origin}/catalog`
  const catalogCredential = catalogCredentialQuery.data?.credential ?? null
  const activeCatalogAction = catalogAction?.companyId === me.active_company_id ? catalogAction.action : null
  const activeNewCatalogLink = newCatalogLink?.companyId === me.active_company_id ? newCatalogLink : null
  const visibleCatalogApiId = activeNewCatalogLink?.apiId
    ?? (catalogCredential?.status === 'active' ? catalogCredential.public_id : '')
  const websiteCatalogApiUrl = buildWebsiteCatalogUrl(supabaseProjectUrl, visibleCatalogApiId)
  const websiteCatalogSnippet = buildWebsiteCatalogSnippet(websiteCatalogApiUrl)
  const catalogDetailsUnlocked = catalogUnlockCompanyId === me.active_company_id
  const unlockCatalogDetails = () => {
    if (catalogPassword !== CATALOG_DETAILS_PASSWORD) {
      setCatalogPasswordError('Incorrect password. Try again.')
      return
    }
    setCatalogUnlockCompanyId(me.active_company_id)
    setCatalogPassword('')
    setCatalogPasswordError(null)
  }
  const lockCatalogDetails = () => {
    setCatalogUnlockCompanyId(null)
    setCatalogPassword('')
    setCatalogPasswordError(null)
  }
  const copySettingValue = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label} copied`, 'It is ready to paste into the website configuration.')
    } catch {
      toast.error(`${label} was not copied`, 'Select the value and copy it manually.')
    }
  }
  const copyCatalogueLink = async () => {
    try {
      await navigator.clipboard.writeText(catalogueLink)
      toast.success('Customer link copied', 'Send this same catalogue link to any customer.')
    } catch {
      toast.error('Link was not copied', 'Select the link and copy it manually.')
    }
  }

  return (
    <div className="page-stack settings-page">
      <PageHeader
        eyebrow="System controls"
        title="System settings"
        description="Manage company setup, controlled user access, and high-risk system operations."
      />

      <Card className="settings-overview">
        <div className="settings-overview__icon"><ShieldCheck size={24} aria-hidden="true" /></div>
        <div>
          <h2>Protected administration</h2>
          <p>
            Every destructive request is authorized again by the API and database, recorded with
            the acting administrator, and completed as one transaction.
          </p>
        </div>
      </Card>

      <Card>
        <SectionTitle
          title="Company invoice details"
          description={`These details and the logo populate ${me.active_company_name} raw-material purchase invoices automatically.`}
          actions={me.permission_codes.includes('system.admin') ? <Button icon={Save} loading={companyProfileMutation.isPending} onClick={() => companyProfileMutation.mutate()}>Save invoice details</Button> : undefined}
        />
        {companyProfileQuery.isLoading ? <LoadingState label="Loading company details…" /> : companyProfileQuery.isError ? <ErrorState error={companyProfileQuery.error} onRetry={() => void companyProfileQuery.refetch()} /> : <div className="form-grid form-grid--two">
          <Field label="Company name"><Input value={companyProfileQuery.data?.name ?? me.active_company_name} readOnly /></Field>
          <Field label="Phone / WhatsApp"><Input type="tel" value={effectiveCompanyDraft.phone} readOnly={!me.permission_codes.includes('system.admin')} onChange={(event) => setCompanyDraft({ ...effectiveCompanyDraft, phone: event.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={effectiveCompanyDraft.email} readOnly={!me.permission_codes.includes('system.admin')} onChange={(event) => setCompanyDraft({ ...effectiveCompanyDraft, email: event.target.value })} /></Field>
          <Field label="Logo URL" hint="Use an HTTPS image URL that can be loaded by the browser and PDF exporter."><Input type="url" value={effectiveCompanyDraft.logo_url} readOnly={!me.permission_codes.includes('system.admin')} onChange={(event) => setCompanyDraft({ ...effectiveCompanyDraft, logo_url: event.target.value })} placeholder="https://…" /></Field>
          <Field label="Address" className="field--span-2"><textarea className="input textarea" rows={3} value={effectiveCompanyDraft.address} readOnly={!me.permission_codes.includes('system.admin')} onChange={(event) => setCompanyDraft({ ...effectiveCompanyDraft, address: event.target.value })} /></Field>
        </div>}
      </Card>

      {me.is_super_admin ? (
        <Card className="user-access-card">
          <SectionTitle
            title="Login accounts & access"
            description={`Create users and review access shown for ${me.active_company_name}. Group super administrators always receive both CK and AR.`}
            actions={<Button icon={UserPlus} onClick={() => setCreateUserOpen(true)}>Create account</Button>}
          />
          <InlineNotice title="Access is enforced in the API and database">
            Selecting a capability controls both visible pages and allowed operations. Passwords are stored only by Supabase Auth.
          </InlineNotice>
          {usersQuery.isLoading ? <LoadingState label="Loading user access..." /> : usersQuery.isError ? <ErrorState error={usersQuery.error} onRetry={() => void usersQuery.refetch()} /> : (
            <TableWrap><table><thead><tr><th>User</th><th>Systems</th><th>Access</th><th>Status</th><th><span className="sr-only">Account actions</span></th></tr></thead><tbody>
              {accounts.map((account) => (
                <tr key={account.user_id}>
                  <td><strong>{account.display_name || account.email || 'Unnamed user'}</strong><span className="table-subtext">{account.email}</span></td>
                  <td>{account.company_access.length ? account.company_access.map((company) => company.code).join(' + ') : 'Not assigned'}</td>
                  <td>{account.is_super_admin ? <Badge tone="purple">Super admin</Badge> : account.company_access.length ? account.company_access.map((company) => `${company.code}: ${company.roles.map(titleCase).join(', ')}`).join(' · ') : 'Not assigned'}</td>
                  <td>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={account.profile_active}
                      aria-label={`Account status for ${account.display_name || account.email || 'user'}`}
                      aria-busy={statusMutation.isPending && statusMutation.variables?.account.user_id === account.user_id}
                      className={`account-status-switch${account.profile_active ? ' account-status-switch--active' : ''}`}
                      title={account.user_id === me.user_id ? 'Your current account cannot be deactivated.' : account.profile_active ? 'Turn account access off' : 'Turn account access on'}
                      disabled={account.user_id === me.user_id || statusMutation.isPending || removeAccountMutation.isPending}
                      onClick={() => statusMutation.mutate({ account, isActive: !account.profile_active })}
                    >
                      <span className="account-status-switch__track" aria-hidden="true"><span className="account-status-switch__thumb" /></span>
                      <span className="account-status-switch__label">{account.profile_active ? 'Active' : 'Inactive'}</span>
                    </button>
                  </td>
                  <td><div className="row-actions">
                    {account.user_id === me.user_id ? <Badge tone="neutral">Current account</Badge> : <>
                      <Button
                        size="small"
                        variant="danger"
                        icon={Trash2}
                        disabled={statusMutation.isPending || removeAccountMutation.isPending}
                        onClick={() => { setAccountToRemove(account); setRemovalPin('') }}
                      >Remove</Button>
                    </>}
                  </div></td>
                </tr>
              ))}
            </tbody></table></TableWrap>
          )}
        </Card>
      ) : null}

      <Card className="settings-guide-launcher">
        <div className="settings-overview__icon"><BookOpen size={24} aria-hidden="true" /></div>
        <div className="settings-guide-launcher__copy">
          <h2>Start here: system workflow</h2>
          <p lang="si">මෙතැනින් ආරම්භ කරන්න: පද්ධතිය භාවිතා කරන පිළිවෙළ</p>
          <span>Read the short English and Sinhala guide before using the system.</span>
        </div>
        <Button icon={BookOpen} onClick={() => setGuideOpen(true)}>
          Open user guide / මාර්ගෝපදේශය
        </Button>
      </Card>

      <Card className="product-settings-card">
        <SectionTitle
          title="Products & customer catalogue"
          description="Manage customer-ready product details here or from Production. Stock quantities and costs are never shown on the public link."
          actions={<div className="row-actions"><Button variant="secondary" icon={Copy} onClick={() => void copyCatalogueLink()}>Copy customer link</Button><Button icon={Plus} onClick={() => { setEditingProduct(null); setProductOpen(true) }}>Add product</Button></div>}
        />
        <div className="catalogue-share-bar">
          <div><Boxes size={21} /><span><strong>One reusable customer link</strong><small>New products and edits appear automatically.</small></span></div>
          <a className="button button--secondary" href={catalogueLink} target="_blank" rel="noreferrer"><ExternalLink size={17} /> Open catalogue</a>
        </div>
        <Input value={catalogueLink} readOnly aria-label="Customer catalogue link" onFocus={(event) => event.currentTarget.select()} />
        {productsQuery.isLoading ? <LoadingState label="Loading products…" /> : productsQuery.isError ? <ErrorState error={productsQuery.error} onRetry={() => void productsQuery.refetch()} /> : productsQuery.data?.items.length ? <ProductCards products={productsQuery.data.items} onEdit={(product) => { setEditingProduct(product); setProductOpen(true) }} onReverse={setReversingProduct} /> : <EmptyState message="No products have been added yet." action={<Button icon={Plus} onClick={() => setProductOpen(true)}>Add first product</Button>} />}
      </Card>

      <Card className="conversion-settings">
        <SectionTitle
          title="Conversion types & rates"
          description="Create the dropdown values used by Production & conversion. Manual entry remains available for one-off work."
          actions={<div className="row-actions"><Button variant="secondary" icon={Tags} onClick={() => setTypeDialogOpen(true)}>Add type</Button><Button icon={Wrench} onClick={() => setRateDialogOpen(true)}>Add rate</Button></div>}
        />
        <InlineNotice tone="success" title="One setup, used throughout conversion entry">
          Saved types can prefill the chip stock name. Saved rates fill each worker task and rate, then the posted amount becomes that employee's open payroll earning.
        </InlineNotice>
        <div className="settings-master-grid">
          <section className="settings-master-panel">
            <div className="settings-master-panel__heading"><div><Tags size={18} /><strong>Conversion types</strong></div><span>{conversionTypes.length} saved</span></div>
            {typesQuery.isLoading ? <LoadingState label="Loading conversion types…" /> : typesQuery.isError ? <ConversionSetupError kind="types" error={typesQuery.error} onRetry={() => void typesQuery.refetch()} /> : conversionTypes.length ? <TableWrap><table><thead><tr><th>Type</th><th>Default chip</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{conversionTypes.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><span className="table-subtext">{item.notes ?? ''}</span></td><td>{item.default_chip_name ?? 'Manual on entry'}</td><td><Badge tone={item.status === 'active' ? 'success' : 'neutral'}>{titleCase(item.status)}</Badge></td><td><Button variant="ghost" size="small" icon={Pencil} onClick={() => { setEditingType(item); setTypeDialogOpen(true) }}>Edit</Button></td></tr>)}</tbody></table></TableWrap> : <EmptyState message="No conversion types have been saved." action={<Button size="small" icon={Plus} onClick={() => setTypeDialogOpen(true)}>Add first type</Button>} />}
          </section>
          <section className="settings-master-panel">
            <div className="settings-master-panel__heading"><div><Wrench size={18} /><strong>Conversion rates</strong></div><span>{rates.length} saved</span></div>
            {ratesQuery.isLoading ? <LoadingState label="Loading conversion rates…" /> : ratesQuery.isError ? <ConversionSetupError kind="rates" error={ratesQuery.error} onRetry={() => void ratesQuery.refetch()} /> : rates.length ? <TableWrap><table><thead><tr><th>Type / work</th><th className="numeric">Rate / kg</th><th>Effective</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rates.map((rate) => <tr key={rate.id}><td><strong>{rate.conversion_type_id ? typeNames.get(rate.conversion_type_id) ?? rate.work_type : rate.work_type}</strong><span className="table-subtext">{rate.conversion_type_id ? rate.work_type : 'Manual work type'}</span></td><td className="numeric">{money(rate.rate_per_kg)}</td><td>{shortDate(rate.effective_from)}<span className="table-subtext">to {rate.effective_to ? shortDate(rate.effective_to) : 'Open ended'}</span></td><td><Badge tone={rate.status === 'active' ? 'success' : 'neutral'}>{titleCase(rate.status)}</Badge></td><td><Button variant="ghost" size="small" icon={Pencil} onClick={() => { setEditingRate(rate); setRateDialogOpen(true) }}>Edit</Button></td></tr>)}</tbody></table></TableWrap> : <EmptyState message="No conversion rates have been saved." action={<Button size="small" icon={Plus} onClick={() => setRateDialogOpen(true)}>Add first rate</Button>} />}
          </section>
        </div>
      </Card>

      {me.is_super_admin ? <Card className="danger-zone">
        <SectionTitle
          title="Danger zone"
          description={`Use this only to permanently reset ${me.active_company_name} business records. Accounts and audit history are never deleted by this action.`}
        />
        <InlineNotice tone="danger" title="Permanent live-data deletion">
          Confirm your legal, tax, payroll, and backup retention obligations before continuing.
          This operation cannot be undone from CK SYS.
        </InlineNotice>
        <div className="danger-zone__action">
          <div>
            <strong>Delete {me.active_company_code} business data</strong>
            <span>Keep every login account, the full activity log, and the other company&apos;s records, but remove this company&apos;s operational data and every saved conversion rate.</span>
          </div>
          <Button variant="danger" icon={Trash2} onClick={() => setDialogOpen(true)}>
            Delete all data
          </Button>
        </div>
      </Card> : null}

      {me.permission_codes.includes('system.admin') ? <Card className="catalog-api-settings">
        <SectionTitle
          title="Future & partner websites · Live Catalog API"
          description="Connect any static website directly to the same Supabase catalogue. Changes made in this admin portal appear automatically without maintaining another database or website backend."
          actions={<Badge tone={catalogCredential?.status === 'active' ? 'success' : 'neutral'}>{catalogCredential?.status === 'active' ? 'Active' : catalogCredential?.status === 'revoked' ? 'Revoked' : 'Not created'}</Badge>}
        />
        {catalogCredentialQuery.isLoading ? <LoadingState label="Loading catalogue API settings…" /> : catalogCredentialQuery.isError ? <ErrorState error={catalogCredentialQuery.error} onRetry={() => void catalogCredentialQuery.refetch()} /> : <div className="form-stack">
          <InlineNotice tone="success" title="One public link · no website backend · no secret key">
            Use a normal browser fetch request. The response includes public company details and every active product&apos;s ID, SKU, name, category, image, price, description, unit, and update time. It never includes stock quantities, costs, staff, accounting, customers, or write access.
          </InlineNotice>
          <InlineNotice tone="warning" title="This catalogue URL is intentionally public">
            Anyone who has the link can read the published product catalogue and company contact details. Disable it below if a partner should no longer have access.
          </InlineNotice>
          <div className="catalog-api-fields">
            <Field label="Public website data URL" hint="GET · works from plain HTML, React, Next.js, WordPress, Shopify custom code, and other browser websites"><div className="copy-field"><Input value={websiteCatalogApiUrl || 'Enable the website API to create the link'} readOnly onFocus={(event) => event.currentTarget.select()} /><Button variant="secondary" icon={Copy} disabled={!websiteCatalogApiUrl} onClick={() => void copySettingValue('Website API URL', websiteCatalogApiUrl)}>Copy URL</Button></div></Field>
            {catalogDetailsUnlocked ? <div className="catalog-api-protected catalog-api-protected--open">
              <div className="catalog-api-protected__heading"><div><LockKeyhole size={18} aria-hidden="true" /><span><strong>Protected API details unlocked</strong><small>Visible for this company until you lock them or refresh the page.</small></span></div><Button type="button" size="small" variant="secondary" icon={LockKeyhole} onClick={lockCatalogDetails}>Lock details</Button></div>
              <Field label="Catalog ID" hint="Already included in the URL; no request header is needed"><div className="copy-field"><Input value={visibleCatalogApiId || 'Created automatically'} readOnly onFocus={(event) => event.currentTarget.select()} /><Button variant="secondary" icon={Copy} disabled={!visibleCatalogApiId} onClick={() => void copySettingValue('Catalog ID', visibleCatalogApiId)}>Copy ID</Button></div></Field>
              <Field label="Copy-and-paste JavaScript" hint="Paste this into the partner website and render catalog.company and catalog.items"><div className="catalog-api-code"><textarea className="input textarea" rows={5} value={websiteCatalogSnippet || '// Enable the website API to generate the code'} readOnly onFocus={(event) => event.currentTarget.select()} /><Button variant="secondary" icon={Copy} disabled={!websiteCatalogSnippet} onClick={() => void copySettingValue('JavaScript example', websiteCatalogSnippet)}>Copy code</Button></div></Field>
            </div> : <form className="catalog-api-protected catalog-api-protected--locked" onSubmit={(event) => { event.preventDefault(); unlockCatalogDetails() }}>
              <div className="catalog-api-protected__intro"><LockKeyhole size={22} aria-hidden="true" /><div><strong>Catalog ID and JavaScript are locked</strong><span>Enter the API details password to view and copy these two fields.</span></div></div>
              <div className="catalog-api-unlock">
                <Field label="API details password" error={catalogPasswordError ?? undefined}>
                  <Input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={catalogPassword} onChange={(event) => { setCatalogPassword(event.target.value); setCatalogPasswordError(null) }} />
                </Field>
                <Button type="submit" icon={LockKeyhole} disabled={!catalogPassword}>Unlock details</Button>
              </div>
            </form>}
          </div>
          {catalogCredential ? <small className="catalog-api-last-used">Public link created or regenerated {shortDate(catalogCredential.rotated_at)}. Product changes use the same link automatically.</small> : null}
          <div className="row-actions">
            <Button icon={catalogCredential?.status === 'active' ? RefreshCw : KeyRound} loading={rotateCatalogKeyMutation.isPending} onClick={() => catalogCredential?.status === 'active' ? setCatalogAction({ companyId: me.active_company_id, action: 'rotate' }) : rotateCatalogKeyMutation.mutate()}>{catalogCredential?.status === 'active' ? 'Regenerate public link' : 'Enable website API'}</Button>
            {websiteCatalogApiUrl ? <a className="button button--secondary" href={websiteCatalogApiUrl} target="_blank" rel="noreferrer"><ExternalLink size={17} /> Test live data</a> : null}
            {catalogCredential?.status === 'active' ? <Button variant="danger" icon={Trash2} disabled={rotateCatalogKeyMutation.isPending} onClick={() => setCatalogAction({ companyId: me.active_company_id, action: 'revoke' })}>Disable website API</Button> : null}
          </div>
        </div>}
      </Card> : null}

      <Dialog
        open={guideOpen}
        title="System workflow guide / පද්ධති ක්‍රියාදාම මාර්ගෝපදේශය"
        description="Read this guide before entering business records. / ව්‍යාපාරික වාර්තා ඇතුළත් කිරීමට පෙර මෙම මාර්ගෝපදේශය කියවන්න."
        size="large"
        onClose={() => setGuideOpen(false)}
        footer={<Button onClick={() => setGuideOpen(false)}>Done / අවසන්</Button>}
      >
        <div className="workflow-guide">
          <div className="workflow-guide__flow" aria-label="Recommended system workflow">
            <strong>Recommended flow / නිර්දේශිත පිළිවෙළ</strong>
            <span>Setup → Purchases → Conversion → Production → Inventory → Sales → Payroll → Accounting</span>
          </div>
          <div className="workflow-guide__languages">
            <WorkflowGuideLanguage
              title="English guide"
              intro="Follow these steps in order. Your assigned company and capability access determine which linked pages and actions are available."
              titleKey="englishTitle"
              bodyKey="englishBody"
              lang="en"
            />
            <WorkflowGuideLanguage
              title="සිංහල මාර්ගෝපදේශය"
              intro="මෙම පියවර පිළිවෙළින් අනුගමනය කරන්න. පිවිසුණු සෑම පරිශීලකයෙකුටම සියලු පිටු සහ ක්‍රියා භාවිත කළ හැක."
              titleKey="sinhalaTitle"
              bodyKey="sinhalaBody"
              lang="si"
            />
          </div>
        </div>
      </Dialog>
      <Dialog
        open={createUserOpen}
        title="Create a login account"
        description="Create the Supabase Auth identity and assign company/capability access in one controlled workflow."
        size="large"
        onClose={() => { if (!createUserMutation.isPending) { setCreateUserOpen(false); setCreateUserErrors({}); setCreateUserSubmissionError(null) } }}
        closeDisabled={createUserMutation.isPending}
        footer={<><Button variant="secondary" onClick={() => { setCreateUserOpen(false); setCreateUserErrors({}); setCreateUserSubmissionError(null) }} disabled={createUserMutation.isPending}>Cancel</Button><Button icon={UserPlus} loading={createUserMutation.isPending} onClick={submitNewUser}>Create account</Button></>}
      >
        <div className="form-stack">
          {createUserSubmissionError ? (
            <InlineNotice tone="danger" title="Account was not created">
              {createUserSubmissionError}
            </InlineNotice>
          ) : null}
          <div className="form-grid form-grid--two">
            <Field label="Full name" required hint="Shown in the audit trail and account menu." error={createUserErrors.display_name}><Input value={newUser.display_name} onChange={(event) => { clearCreateUserError('display_name'); setNewUser((value) => ({ ...value, display_name: event.target.value })) }} /></Field>
            <Field label="Email address" required hint="This becomes the unique login name." error={createUserErrors.email}><Input type="email" autoComplete="off" value={newUser.email} onChange={(event) => { clearCreateUserError('email'); setNewUser((value) => ({ ...value, email: event.target.value })) }} /></Field>
            <Field label="Temporary password" required hint="At least 10 characters with upper/lowercase, a number, and a symbol." error={createUserErrors.temporary_password}><Input type="password" autoComplete="new-password" value={newUser.temporary_password} onChange={(event) => { clearCreateUserError('temporary_password'); setNewUser((value) => ({ ...value, temporary_password: event.target.value })) }} /></Field>
            <Field label="System access" required hint="Company data and accounting books remain isolated."><select className="input select" value={newUser.company_access} disabled={newUser.is_super_admin} onChange={(event) => setNewUser((value) => ({ ...value, company_access: event.target.value as CompanyAccessChoice }))}><option value="CK">CK system only</option><option value="AR">AR system only</option><option value="BOTH">Both CK and AR</option></select></Field>
          </div>
          <label className="check-field"><input type="checkbox" checked={newUser.is_super_admin} onChange={(event) => { clearCreateUserError('role_codes'); setNewUser((value) => ({ ...value, is_super_admin: event.target.checked, company_access: event.target.checked ? 'BOTH' : value.company_access, role_codes: event.target.checked ? ['admin'] : value.role_codes })) }} /><span><strong>Group super administrator</strong><small>Full access to both systems and permission to create other super administrators.</small></span></label>
          <fieldset className="access-role-grid" disabled={newUser.is_super_admin}><legend>Capability access</legend>
            {accessRoleOptions.map((role) => <label className="check-field" key={role.code}><input type="checkbox" checked={newUser.role_codes.includes(role.code)} onChange={(event) => { clearCreateUserError('role_codes'); setNewUser((value) => ({ ...value, role_codes: event.target.checked ? [...value.role_codes, role.code] : value.role_codes.filter((code) => code !== role.code) })) }} /><span><strong>{role.label}</strong><small>{role.description}</small></span></label>)}
          </fieldset>
          {createUserErrors.role_codes ? <span className="field__error" role="alert">{createUserErrors.role_codes}</span> : null}
        </div>
      </Dialog>

      <Dialog
        open={accountToRemove !== null}
        title="Remove this login account?"
        description="This immediately blocks ERP access and removes all CK/AR role assignments. Historical accounting and audit references remain intact."
        onClose={() => { if (!removeAccountMutation.isPending) { setAccountToRemove(null); setRemovalPin('') } }}
        closeDisabled={removeAccountMutation.isPending}
        footer={<>
          <Button variant="secondary" disabled={removeAccountMutation.isPending} onClick={() => { setAccountToRemove(null); setRemovalPin('') }}>Cancel</Button>
          <Button
            variant="danger"
            icon={Trash2}
            loading={removeAccountMutation.isPending}
            disabled={!accountToRemove || !removalPinComplete}
            onClick={() => { if (accountToRemove) removeAccountMutation.mutate(accountToRemove) }}
          >Remove account</Button>
        </>}
      >
        <div className="form-stack">
          <InlineNotice tone="danger" title="Login access will stop immediately">
            {accountToRemove?.display_name || accountToRemove?.email || 'This user'} will disappear from Login accounts &amp; access. This does not delete company transactions created by that user.
          </InlineNotice>
          <Field
            label="Account-removal PIN"
            required
            hint="Enter the four-digit administrator PIN."
          >
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              aria-label="Account-removal PIN"
              maxLength={4}
              value={removalPin}
              disabled={removeAccountMutation.isPending}
              onChange={(event) => setRemovalPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
            />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={dialogOpen}
        title={`Permanently delete ${me.active_company_code} business data?`}
        description={`This resets ${me.active_company_name} only. Login accounts, audit history, and the other company are preserved.`}
        size="large"
        onClose={closeDialog}
        closeDisabled={purgeMutation.isPending}
        footer={(
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={purgeMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={purgeMutation.isPending}
              disabled={!canPurge}
              onClick={() => purgeMutation.mutate()}
            >
              Permanently delete data
            </Button>
          </>
        )}
      >
        <div className="purge-confirmation">
          <InlineNotice tone="danger" title="There is no in-app recovery">
            Records are removed in one atomic database transaction. If any part fails, nothing is deleted.
          </InlineNotice>

          <ScopeList icon={Database} title={`Deleted from ${me.active_company_name}`} items={deletedGroups} />
          <ScopeList icon={ShieldCheck} title="Preserved" items={preservedGroups} />
          <ScopeList icon={AlertOctagon} title="Not erased by this control" items={externalGroups} />

          <Field
            label={`Type ${PURGE_CONFIRMATION} exactly`}
            required
            error={confirmation.length > 0 && !confirmationMatches ? 'The confirmation phrase does not match.' : undefined}
          >
            <Input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={purgeMutation.isPending}
              placeholder={PURGE_CONFIRMATION}
            />
          </Field>

          <label className="check-field purge-confirmation__acknowledgement">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              disabled={purgeMutation.isPending}
            />
            <span>I understand this permanently deletes the listed live business records.</span>
          </label>
        </div>
      </Dialog>
      <ConversionTypeDialog open={typeDialogOpen} record={editingType} onClose={closeTypeDialog} />
      <PieceworkRateDialog open={rateDialogOpen} record={editingRate} onClose={closeRateDialog} />
      {productOpen ? <ProductDialog open record={editingProduct} mutation={productMutation} onClose={() => { setProductOpen(false); setEditingProduct(null) }} /> : null}
      <ConfirmDialog
        open={activeCatalogAction !== null}
        title={activeCatalogAction === 'revoke' ? 'Disable the public website API?' : 'Regenerate the public website link?'}
        message={activeCatalogAction === 'revoke'
          ? 'The current link will stop returning product data immediately. You can enable a new link later.'
          : 'The current link will stop working immediately. You must copy the replacement URL into every connected website.'}
        confirmLabel={activeCatalogAction === 'revoke' ? 'Disable API' : 'Regenerate link'}
        destructive
        busy={rotateCatalogKeyMutation.isPending || revokeCatalogKeyMutation.isPending}
        onCancel={() => setCatalogAction(null)}
        onConfirm={() => activeCatalogAction === 'revoke' ? revokeCatalogKeyMutation.mutate() : rotateCatalogKeyMutation.mutate()}
      />
      <ConfirmDialog open={Boolean(reversingProduct)} title="Reverse this product?" message={`${reversingProduct?.name ?? 'This product'} will be hidden from the customer catalogue and new transactions. Existing history is preserved.`} destructive confirmLabel="Reverse product" busy={reverseProductMutation.isPending} onCancel={() => setReversingProduct(null)} onConfirm={() => { if (reversingProduct) reverseProductMutation.mutate(reversingProduct) }} />
    </div>
  )
}

function WorkflowGuideLanguage({
  title,
  intro,
  titleKey,
  bodyKey,
  lang,
}: {
  title: string
  intro: string
  titleKey: 'englishTitle' | 'sinhalaTitle'
  bodyKey: 'englishBody' | 'sinhalaBody'
  lang: 'en' | 'si'
}) {
  const { basePath } = useAppContext()
  return (
    <section className="workflow-guide__language" lang={lang} aria-label={title}>
      <h3>{title}</h3>
      <p className="workflow-guide__intro">{intro}</p>
      <ol>
        {workflowGuideSteps.map((step) => (
          <li key={step.englishTitle}>
            <strong>{step[titleKey]}</strong>
            <span>{step[bodyKey]}</span>
            <Link className="workflow-guide__link" to={`${basePath}${step.path}`}>Open {step.englishTitle}</Link>
          </li>
        ))}
      </ol>
    </section>
  )
}

function ScopeList({
  icon: Icon,
  title,
  items,
}: {
  icon: LucideIcon
  title: string
  items: string[]
}) {
  return (
    <section className="purge-scope">
      <div className="purge-scope__title"><Icon size={18} aria-hidden="true" /><strong>{title}</strong></div>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>
  )
}

function ConversionSetupError({ kind, error, onRetry }: { kind: 'types' | 'rates'; error: unknown; onRetry: () => void }) {
  const schemaPending = error instanceof ApiError && error.code === 'supabase_schema_unavailable'
  const detail = schemaPending
    ? 'The conversion setup database update has not reached this environment yet. Manual conversion entry remains available in Production.'
    : (error instanceof Error ? error.message : 'The saved setup could not be loaded.')
  return (
    <div className="settings-master-error" role="alert">
      <Database size={22} aria-hidden="true" />
      <div>
        <strong>Conversion {kind} are temporarily unavailable</strong>
        <span>{detail}</span>
      </div>
      <Button size="small" variant="secondary" icon={RefreshCw} onClick={onRetry}>Retry</Button>
    </div>
  )
}
