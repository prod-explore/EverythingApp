import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Login } from './Login';

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown = {}) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('Login', () => {
  it('does nothing for an empty password', async () => {
    const fetchMock = answer(200);
    vi.stubGlobal('fetch', fetchMock);
    const onSuccess = vi.fn();
    render(<Login onSuccess={onSuccess} />);
    await userEvent.click(screen.getByRole('button', { name: 'Enter' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('signs in with Enter and reports success', async () => {
    vi.stubGlobal('fetch', answer(200, { ok: true }));
    const onSuccess = vi.fn();
    render(<Login onSuccess={onSuccess} />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'hunter2{Enter}');
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it.each([
    [401, 'Wrong password.'],
    [429, 'Too many failed attempts — try again in a few minutes.'],
    [500, 'Server error (500).'],
  ])('explains a %i', async (status, message) => {
    vi.stubGlobal('fetch', answer(status, {}));
    render(<Login onSuccess={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Enter' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('says so when the server cannot be reached, and clears the error as soon as the user types again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    render(<Login onSuccess={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Enter' }));
    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Password'), 'y');
    expect(screen.queryByText('Could not reach the server.')).not.toBeInTheDocument();
  });
});
