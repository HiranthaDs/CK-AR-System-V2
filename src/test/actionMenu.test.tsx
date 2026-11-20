import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionMenu } from '../components/ActionMenu'
import { Button } from '../components/UI'

afterEach(cleanup)

describe('row action menu', () => {
  it('keeps all actions in one menu and closes after the selected action', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    render(
      <ActionMenu>
        <Button variant="ghost" onClick={onEdit}>Edit</Button>
        <Button variant="ghost">Reverse</Button>
        <Button variant="ghost" disabled>Deactivate</Button>
      </ActionMenu>,
    )

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reverse' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument()
  })
})
