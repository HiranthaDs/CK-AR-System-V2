import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Plus,
  Printer,
  RotateCcw,
  Settings2,
  UserRound,
  WalletCards,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod/v3'
import { api } from '../lib/api'
import { supabase } from '../lib/supabase'
import { downloadEmployeeProfilePdf } from '../lib/employeeProfilePdf'
import { dateForFiscalYear, monthForFiscalYear } from '../lib/fiscalYear'
import {
  localIsoDate,
  localIsoMonth,
  money,
  monthLabel,
  numberValue,
  quantity,
  shortDate,
  titleCase,
} from '../lib/format'
import type {
  DailyWork,
  Employee,
  MutationReceipt,
  OvertimeRecord,
  Page,
  SalaryAdvance,
  ShiftSettings,
} from '../types/api'
import { ActionMenu } from './ActionMenu'
import { Dialog } from './Dialog'
import { RemoteSelect } from './RemoteSelect'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  FormActions,
  Input,
  LoadingState,
  Pagination,
  SearchBox,
  SectionTitle,
  TableWrap,
  Textarea,
} from './UI'

export interface SalaryAdvanceValues {
  employee_id: string
  advance_date: string
  amount: number
  notes: string
}

export interface ShiftSettingsValues {
  day_start: string
  day_end: string
  night_start: string
  night_end: string
}

const advanceSchema = z.object({
  employee_id: z.string().uuid('Select an employee.'),
  advance_date: z.string().min(1, 'Select the date the advance was taken.'),
  amount: z.coerce.number().positive('Advance amount must be greater than zero.'),
  notes: z.string().max(1000),
})

const shiftSchema = z
  .object({
    day_start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    day_end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    night_start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    night_end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .superRefine((value, context) => {
    if (value.day_end !== value.night_start)
      context.addIssue({
        code: 'custom',
        path: ['night_start'],
        message: 'Night Shift must start when Day Shift ends.',
      })
    if (value.night_end !== value.day_start)
      context.addIssue({
        code: 'custom',
        path: ['night_end'],
        message: 'Night Shift must end when the next Day Shift starts.',
      })
  })

function statusTone(status: string | null | undefined) {
  if (status === 'active' || status === 'posted' || status === 'paid') return 'success' as const
  if (status === 'partial' || status === 'payable') return 'warning' as const
  if (status === 'reversed' || status === 'inactive') return 'danger' as const
  return 'neutral' as const
}

function rangeForMonth(month: string) {
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return {
    from_date: `${month}-01`,
    to_date: `${month}-${String(lastDay).padStart(2, '0')}`,
  }
}

function adjacentMonth(month: string, offset: number) {
  const date = new Date(`${month}-01T00:00:00`)
  date.setMonth(date.getMonth() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function timeValue(value: string | null | undefined, fallback = '') {
  return value ? value.slice(0, 5) : fallback
}

function clockLabel(value: string | null | undefined) {
  if (!value) return '—'
  const [hours = Number.NaN, minutes = Number.NaN] = value.slice(0, 5).split(':').map(Number)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return value
  return `${String(hours % 12 || 12).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`
}

function clockMinutes(value: string) {
  const [hours = Number.NaN, minutes = Number.NaN] = value.split(':').map(Number)
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : 0
}

function previewOtHours(start: string, out: string, nightStart: string, nightEnd: string) {
  const workStart = clockMinutes(start)
  let workEnd = clockMinutes(out)
  if (workEnd <= workStart) workEnd += 1440
  const otStart = clockMinutes(nightStart)
  let otEnd = clockMinutes(nightEnd)
  if (otEnd <= otStart) otEnd += 1440
  return Math.max(0, Math.min(workEnd, otEnd) - Math.max(workStart, otStart)) / 60
}

async function signedEmployeePhoto(path: string | null | undefined) {
  if (!path) return ''
  const { data, error } = await supabase.storage.from('employee-profile-images').createSignedUrl(path, 3600)
  if (error) throw new Error(error.message)
  return data.signedUrl
}

type DailyLogFilter = 'all' | 'present' | 'absent' | 'late' | 'ot'

export function EmployeeDailyLogDialog({
  employee,
  year,
  onClose,
}: {
  employee: Employee | null
  year: number
  onClose: () => void
}) {
  const [month, setMonth] = useState(() => monthForFiscalYear(year, localIsoMonth()))
  const [filter, setFilter] = useState<DailyLogFilter>('all')
  const range = rangeForMonth(month)
  const workQuery = useQuery({
    queryKey: ['employee-daily-log', 'work', employee?.id, month],
    queryFn: ({ signal }) =>
      api.list<DailyWork>(
        '/daily-work',
        {
          employee_id: employee!.id,
          ...range,
          page: 1,
          page_size: 100,
          descending: false,
        },
        signal,
      ),
    enabled: Boolean(employee),
  })
  const overtimeQuery = useQuery({
    queryKey: ['employee-daily-log', 'ot', employee?.id, month],
    queryFn: ({ signal }) =>
      api.list<OvertimeRecord>(
        '/overtime',
        {
          employee_id: employee!.id,
          ...range,
          page: 1,
          page_size: 100,
          descending: false,
        },
        signal,
      ),
    enabled: Boolean(employee),
  })
  const rows = useMemo(() => {
    const workByDate = new Map(
      (workQuery.data?.items ?? []).filter((item) => item.status !== 'reversed').map((item) => [item.work_date, item]),
    )
    const otByDate = new Map(
      (overtimeQuery.data?.items ?? [])
        .filter((item) => item.status !== 'reversed')
        .map((item) => [item.work_date, item]),
    )
    const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
    return Array.from({ length: days }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, '0')}`
      const work = workByDate.get(date)
      const overtime = otByDate.get(date)
      const absent = Boolean(work?.is_absent)
      const present = Boolean(work) && !absent
      const late = Boolean(work && !absent && work.is_late)
      const otHours = overtime ? numberValue(overtime.hours) : numberValue(work?.night_ot_hours)
      return { date, work, absent, present, late, otHours }
    })
  }, [month, workQuery.data?.items, overtimeQuery.data?.items])
  const visibleRows = rows.filter(
    (row) =>
      filter === 'all' ||
      (filter === 'present' && row.present) ||
      (filter === 'absent' && row.absent) ||
      (filter === 'late' && row.late) ||
      (filter === 'ot' && row.otHours > 0),
  )
  const presentDays = rows.filter((row) => row.present).length
  const absentDays = rows.filter((row) => row.absent).length
  const lateDays = rows.filter((row) => row.late).length
  const totalOt = rows.reduce((sum, row) => sum + row.otHours, 0)

  return (
    <Dialog
      open={Boolean(employee)}
      title={`${employee?.name ?? 'Employee'} · ${monthLabel(month)} Log`}
      description="Attendance, time, OT, activity, and notes from actual Daily Work records. Financial values are excluded."
      size="workspace"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="employee-log-toolbar">
        <div className="employee-log-toolbar__month">
          <Button
            variant="secondary"
            size="small"
            onClick={() => setMonth(adjacentMonth(month, -1))}
            disabled={month === `${year}-01`}
            aria-label="Previous month"
          >
            <ChevronLeft size={16} />
          </Button>
          <label>
            <span className="sr-only">Log month</span>
            <Input
              type="month"
              min={`${year}-01`}
              max={`${year}-12`}
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </label>
          <Button
            variant="secondary"
            size="small"
            onClick={() => setMonth(adjacentMonth(month, 1))}
            disabled={month === `${year}-12`}
            aria-label="Next month"
          >
            <ChevronRight size={16} />
          </Button>
        </div>
        <strong>{monthLabel(month)}</strong>
      </div>
      <div className="employee-log-filters" role="group" aria-label="Daily log filters">
        {(
          [
            ['all', 'All'],
            ['present', 'Present Days'],
            ['absent', 'Absent Days'],
            ['late', 'Late Arrivals'],
            ['ot', 'OT Days'],
          ] as Array<[DailyLogFilter, string]>
        ).map(([value, label]) => (
          <Button
            type="button"
            size="small"
            variant={filter === value ? 'primary' : 'secondary'}
            key={value}
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="employee-log-summary">
        <Card>
          <span>Present days</span>
          <strong>{presentDays}</strong>
        </Card>
        <Card>
          <span>Absent / no record</span>
          <strong>{absentDays}</strong>
        </Card>
        <Card>
          <span>Late arrivals</span>
          <strong>{lateDays}</strong>
        </Card>
        <Card>
          <span>Total OT hours</span>
          <strong>{quantity(totalOt, 2)}h</strong>
        </Card>
      </div>
      {workQuery.isLoading || overtimeQuery.isLoading ? (
        <LoadingState label="Loading employee activity…" />
      ) : workQuery.isError || overtimeQuery.isError ? (
        <ErrorState
          error={workQuery.error ?? overtimeQuery.error}
          onRetry={() => {
            void workQuery.refetch()
            void overtimeQuery.refetch()
          }}
        />
      ) : (
        <TableWrap>
          <table className="employee-log-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Attendance</th>
                <th>In / Out Time</th>
                <th>Working Hours</th>
                <th>Daily Work / Activity</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(({ date, work, absent, present, late, otHours }) => (
                <tr key={date}>
                  <td data-label="Date">
                    <strong>
                      {new Date(`${date}T00:00:00`).toLocaleDateString('en-LK', {
                        month: 'short',
                        day: '2-digit',
                        weekday: 'short',
                      })}
                    </strong>
                  </td>
                  <td data-label="Attendance">
                    <Badge tone={absent ? 'danger' : late ? 'warning' : present ? 'success' : 'neutral'}>
                      {absent ? 'Absent' : late ? 'Late' : present ? 'Present' : 'No record'}
                    </Badge>
                  </td>
                  <td data-label="In / Out">{absent ? '—' : `${clockLabel(work?.in_time)} / ${clockLabel(work?.out_time)}`}</td>
                  <td data-label="Working hours">
                    <strong>Total {quantity(work?.total_hours, 2)}h</strong>
                    <span className="table-subtext">
                      Day {quantity(work?.day_hours, 2)}h · OT {quantity(otHours, 2)}h
                    </span>
                  </td>
                  <td data-label="Activity">{work?.activity || '—'}</td>
                  <td data-label="Notes">{work?.notes || (work ? '—' : 'No Daily Work record')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Dialog>
  )
}

export function EmployeeProfileDialog({
  employee,
  companyName,
  onClose,
}: {
  employee: Employee | null
  companyName: string
  onClose: () => void
}) {
  const [photo, setPhoto] = useState({ path: '', url: '' })
  const [downloading, setDownloading] = useState(false)
  useEffect(() => {
    const path = employee?.profile_picture_path
    if (!path) return
    let active = true
    void signedEmployeePhoto(path)
      .then((url) => {
        if (active) setPhoto({ path, url })
      })
      .catch(() => {
        if (active) setPhoto({ path, url: '' })
      })
    return () => {
      active = false
    }
  }, [employee?.profile_picture_path])
  const photoUrl = employee?.profile_picture_path === photo.path ? photo.url : ''
  const download = async () => {
    if (!employee) return
    setDownloading(true)
    try {
      await downloadEmployeeProfilePdf(employee, companyName, photoUrl)
    } finally {
      setDownloading(false)
    }
  }
  return (
    <Dialog
      open={Boolean(employee)}
      title={`Employee Profile · ${employee?.name ?? ''}`}
      description="A complete, print-ready employee master profile."
      size="workspace"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" icon={Printer} onClick={() => window.print()}>
            Print profile
          </Button>
          <Button icon={Download} loading={downloading} onClick={() => void download()}>
            Download PDF
          </Button>
        </>
      }
    >
      {employee ? (
        <article className="employee-profile-document profile-print-area">
          <header className="employee-profile-hero">
            <div className="employee-profile-photo">
              {photoUrl ? <img src={photoUrl} alt={employee.name} /> : <UserRound size={54} />}
            </div>
            <div>
              <span>{companyName}</span>
              <h2>{employee.name}</h2>
              <p>
                {employee.employee_no || 'No employee number'} · {employee.job_role || 'No designation'}
              </p>
              <Badge tone={statusTone(employee.status)}>{titleCase(employee.status)}</Badge>
            </div>
          </header>
          <div className="employee-profile-sections">
            <section className="employee-profile-section">
              <h3>Personal information</h3>
              <dl>
                <dt>NIC</dt>
                <dd>{employee.nic || '—'}</dd>
                <dt>Date of birth</dt>
                <dd>{shortDate(employee.date_of_birth)}</dd>
                <dt>Address</dt>
                <dd>{employee.address || '—'}</dd>
              </dl>
            </section>
            <section className="employee-profile-section">
              <h3>Contact information</h3>
              <dl>
                <dt>Phone</dt>
                <dd>{employee.phone || '—'}</dd>
                <dt>Email</dt>
                <dd>{employee.email || '—'}</dd>
              </dl>
            </section>
            <section className="employee-profile-section">
              <h3>Employment information</h3>
              <dl>
                <dt>Designation</dt>
                <dd>{employee.job_role || '—'}</dd>
                <dt>Department</dt>
                <dd>{employee.department || '—'}</dd>
                <dt>Employment type</dt>
                <dd>{employee.employment_type || '—'}</dd>
                <dt>Shift</dt>
                <dd>{employee.shift || '—'}</dd>
                <dt>Joined</dt>
                <dd>{shortDate(employee.joined_date)}</dd>
              </dl>
            </section>
            <section className="employee-profile-section">
              <h3>Payroll identifiers</h3>
              <dl>
                <dt>Pay model</dt>
                <dd>{titleCase(employee.pay_model)}</dd>
                <dt>EPF number</dt>
                <dd>{employee.epf_no || '—'}</dd>
                <dt>ETF reference</dt>
                <dd>{employee.etf_ref || '—'}</dd>
                <dt>Tax number</dt>
                <dd>{employee.tax_no || '—'}</dd>
              </dl>
            </section>
            <section className="employee-profile-section employee-profile-section--wide">
              <h3>Education qualifications</h3>
              <p>{employee.education_qualifications || 'No education qualifications recorded.'}</p>
            </section>
            <section className="employee-profile-section employee-profile-section--wide">
              <h3>Other qualifications</h3>
              <p>{employee.other_qualifications || 'No other qualifications recorded.'}</p>
            </section>
            <section className="employee-profile-section employee-profile-section--wide">
              <h3>Additional information</h3>
              <p>{employee.profile_notes || 'No additional information recorded.'}</p>
            </section>
          </div>
        </article>
      ) : null}
    </Dialog>
  )
}

export function SalaryAdvancesList({
  query,
  page,
  setPage,
  search,
  setSearch,
  onAdd,
  onReverse,
}: {
  query: UseQueryResult<Page<SalaryAdvance>, Error>
  page: number
  setPage: (page: number) => void
  search: string
  setSearch: (value: string) => void
  onAdd: () => void
  onReverse: (advance: SalaryAdvance) => void
}) {
  const rows = query.data?.items ?? []
  return (
    <Card>
      <SectionTitle
        title="Salary advances"
        description="Record the exact date and amount once. Payroll automatically deducts every unclaimed advance in that salary month."
        actions={
          <Button icon={Plus} onClick={onAdd}>
            Record advance
          </Button>
        }
      />
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search employee name" />
      </div>
      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length ? (
        <>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Date / reference</th>
                  <th>Employee</th>
                  <th className="numeric">Advance amount</th>
                  <th>Notes</th>
                  <th>Payroll / status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const claimed = Boolean(row.claimed_payroll_id)
                  return (
                    <tr key={row.id}>
                      <td data-label="Date / reference">
                        <strong className="mono">{row.reference_no}</strong>
                        <span className="table-subtext">{shortDate(row.advance_date)}</span>
                      </td>
                      <td data-label="Employee">
                        <strong>{row.employee_name || row.employee_id.slice(0, 8)}</strong>
                        <span className="table-subtext">{row.employee_no || 'Employee'}</span>
                      </td>
                      <td className="numeric" data-label="Advance amount">
                        <strong>{money(row.amount)}</strong>
                      </td>
                      <td data-label="Notes">{row.notes || '—'}</td>
                      <td data-label="Payroll / status">
                        {row.claimed_payroll_reference || (claimed ? 'Claimed' : 'Waiting for payroll')}
                        <span className="table-subtext">
                          <Badge
                            tone={statusTone(row.status === 'reversed' ? 'reversed' : claimed ? 'partial' : 'posted')}
                          >
                            {row.status === 'reversed' ? 'Reversed' : claimed ? 'Deducted' : 'Open'}
                          </Badge>
                        </span>
                      </td>
                      <td data-label="Actions">
                        <ActionMenu>
                          <Button
                            size="small"
                            variant="ghost"
                            icon={RotateCcw}
                            disabled={claimed || row.status === 'reversed'}
                            onClick={() => onReverse(row)}
                          >
                            Reverse
                          </Button>
                        </ActionMenu>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
          <Pagination
            page={query.data?.page ?? page}
            pages={query.data?.pages ?? 0}
            total={query.data?.total ?? 0}
            onChange={setPage}
          />
        </>
      ) : (
        <EmptyState
          message="No salary advances match this view."
          action={
            <Button icon={Plus} onClick={onAdd}>
              Record first advance
            </Button>
          }
        />
      )}
    </Card>
  )
}

export function SalaryAdvanceDialog({
  open,
  year,
  initialEmployee,
  mutation,
  onClose,
}: {
  open: boolean
  year: number
  initialEmployee: Employee | null
  mutation: UseMutationResult<MutationReceipt, Error, SalaryAdvanceValues>
  onClose: () => void
}) {
  const form = useForm<SalaryAdvanceValues>({
    resolver: zodResolver(advanceSchema),
    defaultValues: {
      employee_id: '',
      advance_date: dateForFiscalYear(year, localIsoDate()),
      amount: 0,
      notes: '',
    },
  })
  useEffect(() => {
    if (open)
      form.reset({
        employee_id: initialEmployee?.id ?? '',
        advance_date: dateForFiscalYear(year, localIsoDate()),
        amount: 0,
        notes: '',
      })
  }, [open, initialEmployee?.id, year])
  const submit = form.handleSubmit((values) => mutation.mutate(values))
  return (
    <Dialog
      open={open}
      title="Record salary advance"
      description="Use the date the employee actually took the advance. The matching salary month will deduct it automatically."
      size="large"
      onClose={onClose}
      closeDisabled={mutation.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon={WalletCards} loading={mutation.isPending} onClick={() => void submit()}>
            Save advance
          </Button>
        </>
      }
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <RemoteSelect<Employee>
          label="Employee"
          endpoint="/employees"
          queryKey="salary-advance-employee"
          query={{ status: 'active' }}
          value={form.watch('employee_id')}
          onChange={(value) => form.setValue('employee_id', value, { shouldValidate: true })}
          optionValue={(item) => item.id}
          optionLabel={(item) => `${item.name} · ${item.employee_no || 'No number'}`}
          required
          disabled={Boolean(initialEmployee)}
          selectedLabel={
            initialEmployee ? `${initialEmployee.name} · ${initialEmployee.employee_no || 'No number'}` : undefined
          }
          error={form.formState.errors.employee_id?.message}
        />
        <div className="form-grid form-grid--two">
          <Field label="Date advance taken" required>
            <Input type="date" min={`${year}-01-01`} max={`${year}-12-31`} {...form.register('advance_date')} />
          </Field>
          <Field label="Advance amount (LKR)" required error={form.formState.errors.amount?.message}>
            <Input type="number" min="0.01" step="0.01" {...form.register('amount')} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea rows={3} placeholder="Optional reason or reference" {...form.register('notes')} />
        </Field>
      </form>
    </Dialog>
  )
}

const fallbackShift: ShiftSettings = {
  company_id: '',
  day_start: '08:30',
  day_end: '17:30',
  night_start: '17:30',
  night_end: '08:30',
}

export function ShiftSettingsPanel({
  query,
  mutation,
}: {
  query: UseQueryResult<Page<ShiftSettings>, Error>
  mutation: UseMutationResult<MutationReceipt, Error, ShiftSettingsValues>
}) {
  const current = query.data?.items[0] ?? fallbackShift
  const form = useForm<ShiftSettingsValues>({
    resolver: zodResolver(shiftSchema),
    values: {
      day_start: timeValue(current.day_start, '08:30'),
      day_end: timeValue(current.day_end, '17:30'),
      night_start: timeValue(current.night_start, '17:30'),
      night_end: timeValue(current.night_end, '08:30'),
    },
  })
  const submit = form.handleSubmit((values) => mutation.mutate(values))
  return (
    <Card className="shift-settings-card">
      <SectionTitle
        title="Shift & OT Settings"
        description="These central times drive Daily Work and automatic OT calculations. Night Shift must begin exactly when Day Shift ends."
      />
      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <form className="shift-settings-form" onSubmit={(event) => void submit(event)}>
          <section className="shift-settings-section">
            <div>
              <CalendarCheck size={22} />
              <span>
                <strong>Day Shift</strong>
                <small>Regular working period · day hours are capped at 8</small>
              </span>
            </div>
            <div className="shift-settings-fields">
              <Field label="Start Time" required>
                <Input type="time" {...form.register('day_start')} />
              </Field>
              <Field label="End Time" required>
                <Input type="time" {...form.register('day_end')} />
              </Field>
            </div>
          </section>
          <section className="shift-settings-section">
            <div>
              <Clock3 size={22} />
              <span>
                <strong>Night Shift / OT</strong>
                <small>Time after Day Shift End is Night OT</small>
              </span>
            </div>
            <div className="shift-settings-fields">
              <Field label="Start Time" required error={form.formState.errors.night_start?.message}>
                <Input type="time" {...form.register('night_start')} />
              </Field>
              <Field label="End Time · next day" required>
                <Input type="time" {...form.register('night_end')} />
              </Field>
            </div>
          </section>
          <div className="shift-settings-preview">
            <span>Current rule</span>
            <strong>OT begins at {clockLabel(form.watch('day_end'))}</strong>
            <small>
              Example: Out Time 09:30 PM gives{' '}
              {quantity(
                previewOtHours(form.watch('day_start'), '21:30', form.watch('night_start'), form.watch('night_end')),
                2,
              )}{' '}
              OT hours.
            </small>
          </div>
          <FormActions>
            <Button icon={Settings2} loading={mutation.isPending} onClick={() => void submit()}>
              Save Shift & OT Settings
            </Button>
          </FormActions>
        </form>
      )}
    </Card>
  )
}
