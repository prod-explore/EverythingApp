import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, UNAUTHORIZED_EVENT, checkSession, getMessages, login } from './api';

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('returns the parsed body of a successful request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { messages: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getMessages('c1')).resolves.toEqual({ messages: [] });
    expect(fetchMock).toHaveBeenCalledWith('/api/conversations/c1/messages', expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }));
  });

  it('announces a 401 to the app shell and throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: 'unauthorized' })));
    const heard = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, heard);
    await expect(getMessages('c1')).rejects.toMatchObject({ name: 'ApiError', status: 401 });
    window.removeEventListener(UNAUTHORIZED_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('uses the server error text, or a generic one when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(409, { error: 'already exists' })).mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 })));
    await expect(getMessages('c1')).rejects.toThrow('already exists');
    await expect(getMessages('c1')).rejects.toThrow('request failed (502)');
  });

  it('a wrong password fails in place and does not log the user out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: 'wrong password' })));
    const heard = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, heard);
    const err = await login('nope').catch((e: unknown) => e);
    window.removeEventListener(UNAUTHORIZED_EVENT, heard);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: 'wrong password', status: 401 });
    expect(heard).not.toHaveBeenCalled();
  });

  it('sends the password in the body, never in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await login('s3cret');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/login');
    expect(String(url)).not.toContain('s3cret');
    expect(JSON.parse(init.body)).toEqual({ password: 's3cret' });
  });

  it('checkSession is true only for an authenticated answer, and false when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, { authed: true })).mockResolvedValueOnce(reply(200, { authed: false })).mockRejectedValueOnce(new TypeError('network')));
    expect(await checkSession()).toBe(true);
    expect(await checkSession()).toBe(false);
    expect(await checkSession()).toBe(false);
  });
});
