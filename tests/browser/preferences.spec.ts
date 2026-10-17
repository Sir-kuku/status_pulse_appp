import { test, expect } from '@playwright/test';

const configuredOptions = {
  providers: [{ id: 'google', name: 'Google', startUrl: '/api/auth/oauth/google/start' }],
  email: { enabled: true, mode: 'resend' },
  branding: { creatorName: 'Sir. Kuku', creatorUrl: 'https://github.com/Sir-kuku' }, simulations: false,
};

test('auth options recover from a transient failure and show configured sign-in choices', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/auth/options', async route => {
    calls++;
    if (calls === 1) await route.fulfill({ status: 503, json: { error: { code: 'TEMPORARILY_UNAVAILABLE' } } });
    else await route.fulfill({ json: configuredOptions });
  });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  expect(calls).toBe(2);
  expect(await page.evaluate(() => (window as any).StatusPulsePreferences.status)).toBe('ready');
  expect(await page.evaluate(async () => (await (window as any).StatusPulsePreferences.options).email.enabled)).toBe(true);
});

test('unavailable options remain distinct from disabled email and can be reloaded without duplicate requests', async ({ page }) => {
  let calls = 0, available = false;
  await page.route('**/api/auth/options', async route => {
    calls++;
    await route.fulfill(available ? { json: { ...configuredOptions, email: { enabled: false, mode: 'disabled' } } }
      : { status: 503, json: { error: { code: 'TEMPORARILY_UNAVAILABLE' } } });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => (window as any).StatusPulsePreferences.status)).toBe('unavailable');
  expect(calls).toBe(3);
  expect(await page.evaluate(async () => (window as any).StatusPulsePreferences.options)).toBeNull();
  available = true;
  const recovered = await page.evaluate(async () => {
    const preferences = (window as any).StatusPulsePreferences;
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail.status);
    addEventListener('status-pulse:options', listener);
    const first = preferences.reloadOptions(), second = preferences.reloadOptions();
    const options = await first;
    removeEventListener('status-pulse:options', listener);
    return { deduped: first === second, options, status: preferences.status, latestPromise: preferences.options === first, events };
  });
  expect(recovered.deduped).toBe(true);
  expect(recovered.latestPromise).toBe(true);
  expect(recovered.status).toBe('ready');
  expect(recovered.options.email).toEqual({ enabled: false, mode: 'disabled' });
  expect(recovered.events).toEqual(['loading', 'ready']);
  expect(calls).toBe(4);
});
