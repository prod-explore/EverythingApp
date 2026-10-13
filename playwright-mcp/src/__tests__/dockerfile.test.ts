import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// dist/__tests__ → package root
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('Dockerfile', () => {
  it('uses the Playwright image that matches the locked playwright package (its Chromium revision)', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string }> };
    const version = lock.packages['node_modules/playwright']?.version;
    assert.ok(version, 'playwright is in package-lock.json');
    const docker = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const tag = /^ARG PLAYWRIGHT_IMAGE_TAG=(\S+)$/m.exec(docker)?.[1];
    assert.equal(tag, `v${version}-noble`, 'bump ARG PLAYWRIGHT_IMAGE_TAG in Dockerfile together with the playwright dependency');
  });
});
