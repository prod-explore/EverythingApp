import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { quarantineObservation } from '../quarantine.js';
import type { PlaywrightConfig } from '../config.js';

const config: PlaywrightConfig = {
  mcpPort: 3003,
  apiKey: 'test-key',
  quarantineModelUrl: 'http://fake-quarantine.local/v1',
  quarantineModel: 'fake-model',
  quarantineMaxInputChars: 80000,
  navTimeoutMs: 30000,
  maxSessions: 4,
  sessionIdleTimeoutMs: 1800000,
  watchdogIntervalMs: 120000,
  observationMaxInputChars: 100, // small on purpose, to exercise truncation below
  allowPrivateHosts: [],
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchOnce(body: string, ok = true) {
  globalThis.fetch = (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      text: async () => body,
      json: async () => JSON.parse(body),
    }) as unknown as Response) as typeof fetch;
}

describe('quarantineObservation', () => {
  it('parses a well-formed JSON response into summary + elementTable', async () => {
    mockFetchOnce(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: 'A login page.', elementTable: '[1] button: "Log in"' }) } }],
      }),
    );

    const result = await quarantineObservation(config, 'Welcome, please log in.', '[1] button: "Log in"');
    assert.equal(result.summary, 'A login page.');
    assert.equal(result.elementTable, '[1] button: "Log in"');
    assert.equal(result.model, 'fake-model');
  });

  it('falls back to the raw element table when the model does not return valid JSON', async () => {
    mockFetchOnce(
      JSON.stringify({
        choices: [{ message: { content: 'Sure! This page is a login page. Here you go.' } }],
      }),
    );

    const rawTable = '[1] button: "Log in"\n[2] input: "Username"';
    const result = await quarantineObservation(config, 'Welcome.', rawTable);
    // Non-JSON content becomes the summary verbatim, and the raw (code-generated,
    // not page-supplied) table is used as-is rather than failing the observation.
    assert.equal(result.summary, 'Sure! This page is a login page. Here you go.');
    assert.equal(result.elementTable, rawTable);
  });

  it('throws with the response body when the quarantine model request fails', async () => {
    mockFetchOnce('internal error', false);
    await assert.rejects(
      () => quarantineObservation(config, 'text', 'table'),
      /Quarantine model observation request failed \(500\): internal error/,
    );
  });
});
