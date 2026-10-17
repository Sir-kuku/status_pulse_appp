import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

test('production never defaults to simulated email and requires complete provider settings', () => {
  const production = { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://status-pulse-appp.onrender.com' };
  assert.equal(loadConfig(production).emailMode, 'disabled');
  assert.throws(() => loadConfig({ ...production, EMAIL_MODE: 'simulation' }), /not allowed in production/);
  assert.throws(() => loadConfig({ ...production, EMAIL_MODE: 'resend' }), /requires/);
  assert.equal(loadConfig({ ...production, EMAIL_FROM: 'Status Pulse <updates@example.com>', RESEND_API_KEY: 'test-key' }).emailMode, 'resend');
  assert.throws(() => loadConfig({ ...production, GOOGLE_CLIENT_ID: 'test-client' }), /both GOOGLE/);
  assert.throws(() => loadConfig({ ...production, GITHUB_CLIENT_SECRET: 'test-secret' }), /both GITHUB/);
  assert.throws(() => loadConfig({ ...production, EMAIL_MODE: 'resend', EMAIL_FROM: 'invalid', RESEND_API_KEY: 'test' }), /valid email/);
});

test('callback origin and creator URL validation reject unsafe schemes and ambiguous URLs', () => {
  for (const url of ['https://example.com/path', 'https://user:password@example.com', 'https://example.com?x=1', 'https://example.com/#token=123', 'ftp://example.com']) {
    assert.throws(() => loadConfig({ PUBLIC_BASE_URL: url }));
  }
  assert.throws(() => loadConfig({ CREATOR_URL: 'javascript:alert(1)' }));
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://example.com' }), /HTTPS/);
  assert.equal(loadConfig({ NODE_ENV: 'test' }).emailMode, 'simulation');
  assert.equal(loadConfig({ NODE_ENV: 'test', ENABLE_SIMULATIONS: 'false' }).emailMode, 'disabled');
});
