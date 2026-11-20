// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SupabaseGateway } from '../gateway.js'

const gateway = new SupabaseGateway({
  supabaseUrl: 'https://example.supabase.co',
  publishableKey: 'test-publishable-key',
}, { authClient: { auth: {} } })

describe('Supabase error mapping', () => {
  it('identifies an outdated ERP operation dispatcher', async () => {
    const error = await gateway.mapError(new globalThis.Response(JSON.stringify({
      code: '22023',
      message: 'Unsupported ERP operation: conversion_type.upsert',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))

    expect(error.status).toBe(503)
    expect(error.code).toBe('supabase_schema_unavailable')
    expect(error.message).toContain('apply all pending migrations')
  })

  it('keeps safe database details and hints for accounting failures', async () => {
    const error = await gateway.mapError(new globalThis.Response(JSON.stringify({
      code: '23514',
      message: 'Journal debits and credits must balance',
      details: 'Debit total is 1500.00 while credit total is 1400.00.',
      hint: 'Correct the journal lines before posting again.',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))

    expect(error.status).toBe(422)
    expect(error.code).toBe('business_rule_violation')
    expect(error.message).toBe('Journal debits and credits must balance')
    expect(error.errors).toEqual([
      { type: 'database_detail', loc: ['database'], msg: 'Debit total is 1500.00 while credit total is 1400.00.' },
      { type: 'database_detail', loc: ['database'], msg: 'Correct the journal lines before posting again.' },
    ])
  })
})
