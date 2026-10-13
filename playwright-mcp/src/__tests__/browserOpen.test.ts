import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { approvedHostFor } from '../tools/browserOpen.js';

describe('approvedHostFor (_approved_host from the orchestrator)', () => {
  it('accepts exactly the host of the URL being opened', () => {
    assert.equal(approvedHostFor('https://Shop.Example/cart?x=1', 'shop.example'), 'shop.example');
    assert.equal(approvedHostFor('https://shop.example:8443/', 'SHOP.example.'), 'shop.example');
  });
  it('ignores anything wider, different or missing', () => {
    assert.equal(approvedHostFor('https://shop.example/', 'example'), null);
    assert.equal(approvedHostFor('https://shop.example/', '*.example'), null);
    assert.equal(approvedHostFor('https://evil.example/', 'shop.example'), null);
    assert.equal(approvedHostFor('https://shop.example/', undefined), null);
    assert.equal(approvedHostFor('not a url', 'shop.example'), null);
  });
});
