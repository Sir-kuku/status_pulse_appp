import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const password = 'a browser test passphrase 123!';
async function account(request: APIRequestContext, name = 'Browser Owner') {
  const email = `${randomUUID()}@example.test`;
  const response = await request.post('/api/auth/register', { data: { name, email, password } });
  expect(response.status()).toBe(201);
  return { ...await response.json(), email };
}
async function seed(request: APIRequestContext, owner: any, name = 'Customer platform') {
  const headers = { Authorization: `Bearer ${owner.token}` };
  const result = await request.post('/api/projects', { headers, data: { name, slug: `browser-${randomUUID()}`, publicEnabled: true } });
  expect(result.status()).toBe(201);
  const { project } = await result.json();
  const created = await request.post(`/api/projects/${project._id}/services`, { headers, data: { name: 'Payments API', url: 'https://example.com/private-health', publicVisible: true, recoveryThreshold: 1 } });
  expect(created.status()).toBe(201);
  return { project, service: (await created.json()).service, headers, base: `/api/projects/${project._id}` };
}
async function signIn(page: Page, token: string) {
  await page.addInitScript(value => sessionStorage.setItem('status-pulse-session', value), token);
  await page.goto('/');
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#page-content .loading')).toHaveCount(0);
}
async function navigate(page: Page, name: string) {
  if (await page.locator('#sidebar-toggle').isVisible() && !await page.locator('#navigation').isVisible()) await page.locator('#sidebar-toggle').click();
  await page.locator('#navigation').getByRole('button', { name, exact: true }).click();
  await expect(page.locator('#page-content .loading')).toHaveCount(0);
}
async function screenshot(page: Page, name: string) {
  await mkdir('.local/verification', { recursive: true });
  await page.screenshot({ path: `.local/verification/${name}.png`, fullPage: true });
}

test('owner completes registration, monitoring, response, payment retry and archive workflows', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await screenshot(page, 'sign-in-desktop');
  await page.getByLabel('Your name').fill('Alex Morgan');
  await page.getByLabel('Email address').fill(`${randomUUID()}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create your account' }).click();
  await page.getByRole('button', { name: 'Create a project →', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Customer platform');
  await page.getByLabel('Public page slug').fill(`customer-${randomUUID()}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('#page-heading').getByRole('button', { name: 'Add monitor' }).click();
  await page.getByLabel('Monitor name').fill('Payments API');
  await page.getByLabel('Endpoint URL').fill('https://example.com/health');
  await page.getByLabel('Successes before recovery').fill('1');
  await page.getByRole('dialog').getByRole('button', { name: 'Add monitor', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('status-pulse-session'));
  const headers = { Authorization: `Bearer ${token}` };
  const projects = await (await request.get('/api/projects', { headers })).json();
  const base = `/api/projects/${projects.projects[0]._id}`;
  await expect.poll(async () => (await (await request.get(`${base}/services`, { headers })).json()).services[0].status).toBe('operational');
  await page.getByRole('button', { name: 'Refresh workspace' }).click();
  await expect(page.getByText('Your services are looking healthy.')).toBeVisible();
  await screenshot(page, 'workspace-desktop');
  await navigate(page, 'Monitors');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Monitor name').fill('Payments API v2');
  await page.getByRole('button', { name: 'Save monitor' }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Configuration history' }).click();
  await expect(page.getByText('Version 2 · Payments API v2')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await navigate(page, 'Incidents');
  await page.getByRole('button', { name: 'Report incident' }).click();
  await page.getByLabel('Incident title').fill('Elevated payment latency');
  await page.getByLabel('Initial update').fill('We are investigating increased response times.');
  await page.getByRole('button', { name: 'Open incident' }).click();
  await page.getByRole('button', { name: 'Elevated payment latency' }).click();
  for (const state of ['identified', 'monitoring', 'resolved']) {
    await page.getByLabel('Next status').selectOption(state);
    await page.getByLabel('Response update').fill(`The team has moved to ${state}.`);
    await page.getByRole('button', { name: 'Post update' }).click();
    await expect(page.getByRole('dialog').locator('.timeline-entry h4').last()).toHaveText(state[0]!.toUpperCase() + state.slice(1));
  }
  await expect(page.getByText('This timeline is read-only.')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await navigate(page, 'Alerts');
  await page.getByRole('button', { name: 'Simulate failure', exact: true }).click();
  await expect(page.locator('#page-content .badge.failed')).toHaveText('Failed');
  await page.getByRole('button', { name: 'Retry delivery' }).click();
  await expect(page.locator('#page-content .badge.delivered')).toHaveText('Delivered');
  await page.getByRole('button', { name: 'Acknowledge', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Acknowledge', exact: true })).toHaveCount(0);
  await navigate(page, 'Project settings');
  await page.getByRole('button', { name: 'Explore advanced plan' }).click();
  await page.getByLabel('Simulated result').selectOption('failure');
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.locator('.plan')).toHaveText('Free plan');
  await page.getByRole('button', { name: 'Payment history' }).click();
  await page.getByRole('button', { name: 'Retry this payment' }).click();
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.locator('.plan')).toHaveText('Advanced plan');
  const payments = await (await request.get(`${base}/payments`, { headers })).json();
  expect(payments.items).toHaveLength(1); expect(payments.items[0].attempts).toBe(2);
  await navigate(page, 'Monitors');
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Archive monitor' }).click();
  await page.getByLabel('Type ARCHIVE to confirm').fill('ARCHIVE');
  await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('No monitors yet.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('team roles can be managed and viewers cannot see write controls', async ({ page, request, browser }) => {
  const owner = await account(request), viewer = await account(request, 'Read Only');
  const { base, headers } = await seed(request, owner);
  await signIn(page, owner.token);
  await navigate(page, 'Team');
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByRole('dialog').getByLabel('Email address').fill(viewer.email);
  await page.getByLabel('Project role').selectOption('viewer');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const invitation = await page.locator('.token-box').textContent();
  expect((await request.post('/api/invitations/accept', { headers: { Authorization: `Bearer ${viewer.token}` }, data: { token: invitation } })).status()).toBe(201);
  const context = await browser.newContext(); const viewerPage = await context.newPage();
  await viewerPage.addInitScript(value => sessionStorage.setItem('status-pulse-session', value), viewer.token);
  await viewerPage.goto('http://127.0.0.1:3107/');
  await expect(viewerPage.locator('#account-role')).toHaveText('viewer');
  await expect(viewerPage.getByRole('button', { name: 'Add monitor', exact: true })).toHaveCount(0);
  await expect(viewerPage.locator('#navigation').getByRole('button', { name: 'Team', exact: true })).toHaveCount(0);
  await navigate(viewerPage, 'Monitors');
  await expect(viewerPage.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  expect((await request.post(`${base}/services`, { headers: { Authorization: `Bearer ${viewer.token}` }, data: { name: 'Forbidden', url: 'https://example.com' } })).status()).toBe(403);
  await context.close();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Refresh workspace' }).click();
  await page.getByRole('button', { name: 'Manage access' }).click();
  await page.getByRole('combobox', { name: 'Access', exact: true }).selectOption('responder');
  await page.getByRole('button', { name: 'Save access' }).click();
  await expect(page.getByRole('row').filter({ hasText: viewer.email })).toContainText('responder');
  await page.getByRole('button', { name: 'Manage access' }).click();
  await page.getByRole('combobox', { name: 'Access', exact: true }).selectOption('remove');
  await page.getByRole('button', { name: 'Save access' }).click();
  expect((await (await request.get(`${base}/members`, { headers })).json()).members).toHaveLength(1);
});

test('public visitors can subscribe and read public updates without private data or script execution', async ({ page, request }) => {
  const owner = await account(request); const { project, service, base, headers } = await seed(request, owner);
  const hostile = '<img src=x onerror="window.injected=true">';
  await request.patch(`${base}/services/${service._id}`, { headers, data: { version: 1, name: hostile } });
  await request.post(`${base}/services`, { headers, data: { name: 'Internal database', url: 'https://example.com/internal' } });
  const opened = await request.post(`${base}/services/${service._id}/incidents`, { headers, data: { title: 'Investigating latency', message: 'Public response update.', publicVisible: true } });
  const { incident } = await opened.json();
  await request.post(`${base}/incidents/${incident._id}/updates`, { headers, data: { version: incident.version, state: 'identified', message: 'SECRET INTERNAL NOTE', publicVisible: false } });
  await page.goto(`/status/${project.slug}`);
  await expect(page.locator('#public-services')).toContainText(hostile);
  await expect(page.locator('#public-services')).not.toContainText('Internal database');
  expect(await page.locator('#public-services img').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
  expect(await page.content()).not.toContain('private-health');
  await page.getByRole('button', { name: 'Investigating latency' }).click();
  await expect(page.getByRole('dialog')).toContainText('Public response update.');
  await expect(page.getByRole('dialog')).not.toContainText('SECRET INTERNAL NOTE');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByLabel('Email address').fill(`${randomUUID()}@example.test`);
  await page.getByRole('checkbox', { name: hostile }).check();
  await page.getByRole('button', { name: 'Request updates' }).click();
  await expect(page.getByLabel('Verification code')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Complete simulated verification' }).click();
  await expect(page.locator('#public-message')).toContainText('Subscription activated through simulation');
  await screenshot(page, 'public-status-desktop');
});

test('mobile navigation, reduced motion, empty states and modal keyboard controls work', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const owner = await account(request); await seed(request, owner);
  await signIn(page, owner.token);
  await expect(page.locator('#sidebar-toggle')).toBeVisible();
  await expect(page.locator('#navigation')).not.toBeVisible();
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#navigation')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#navigation')).not.toBeVisible();
  await expect(page.locator('#sidebar-toggle')).toBeFocused();
  await navigate(page, 'Monitors');
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await navigate(page, 'Overview');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.stat-card').first().evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
  await screenshot(page, 'workspace-mobile');
});

test('failed loads can be retried and expired sessions return to account access', async ({ page, request }) => {
  const owner = await account(request); await seed(request, owner);
  await page.route('**/api/projects/*/services?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Temporary service interruption.' } }) }));
  await signIn(page, owner.token);
  await expect(page.getByText('We couldn’t load this workspace.')).toBeVisible();
  await page.unroute('**/api/projects/*/services?*');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('#page-heading h1')).toHaveText('Overview');
  await request.post('/api/auth/logout', { headers: { Authorization: `Bearer ${owner.token}` } });
  await page.getByRole('button', { name: 'Refresh workspace' }).click();
  await expect(page.locator('#auth-screen')).toBeVisible();
  await expect(page.locator('#workspace')).not.toBeVisible();
});
