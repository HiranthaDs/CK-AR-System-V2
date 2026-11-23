import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PopupSelect } from '../components/PopupSelect'

describe('searchable popup select', () => {
  it('filters choices and returns the selected value', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <PopupSelect
        label="Pay model"
        value=""
        onChange={onChange}
        options={[
          { value: 'monthly', label: 'Monthly salary' },
          { value: 'piecework', label: 'Piecework' },
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Select an option' }))
    await user.type(screen.getByRole('textbox', { name: 'Search Pay model' }), 'piece')

    expect(screen.queryByRole('option', { name: 'Monthly salary' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'Piecework' }))
    expect(onChange).toHaveBeenCalledWith('piecework')
  })
})
