import type { PlaywrightConfig } from '../config.js';

export function testConfig(overrides: Partial<PlaywrightConfig> = {}): PlaywrightConfig {
  return {
    mcpPort: 3003,
    apiKey: 'test-key',
    navTimeoutMs: 30000,
    maxSessions: 4,
    sessionIdleTimeoutMs: 1800000,
    watchdogIntervalMs: 120000,
    allowPrivateHosts: [],
    observationMaxTextChars: 12000,
    observationLabelMaxChars: 100,
    observationMaxElements: 300,
    domainAllow: [],
    domainDeny: [],
    jsPolicy: 'allowed',
    ...overrides,
  };
}

/** Builds a string from code points — avoids invisible characters in test source. */
export const cp = (...points: number[]): string => String.fromCodePoint(...points);
