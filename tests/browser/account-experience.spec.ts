import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const password = 'a memorable browser passphrase 123!';
async function account(request: APIRequestContext, name: string) {
  const email = `${randomUUID()}@example.test`;
  const response = await request.post('/api/auth/register', { data: { name, email, password } });
  expect(response.status()).toBe(201);
  return { ...await response.json(), email };
}

test('themes persist across account pages and docs; password visibility is accessible on mobile', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.locator('#password')).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: 'Hide password', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Hide password', exact: true }).press('Enter');
  await expect(page.locator('#password')).toHaveAttribute('type', 'password');
  await expect(page.locator('#auth-screen')).toBeVisible();
  await expect(page.locator('.auth-bottom [data-creator-credit]')).toContainText('Designed & built by Sir. Kuku');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('.local/verification', { recursive: true });
  await page.screenshot({ path: '.local/verification/auth-dark-mobile.png', fullPage: true });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto('/docs');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Light theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'System theme', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(errors).toEqual([]);
});

test('sign-in displays configured providers and explains a failed OAuth callback', async ({ page }) => {
  await page.route('**/api/auth/options', route => route.fulfill({ json: {
    providers: [{ id: 'google', name: 'Google', startUrl: '/api/auth/oauth/google/start' }, { id: 'github', name: 'GitHub', startUrl: '/api/auth/oauth/github/start' }],
    email: { enabled: true, mode: 'resend' }, branding: { creatorName: 'Sir. Kuku', creatorUrl: 'https://github.com/Sir-kuku' }, simulations: false,
  } }));
  await page.goto('/#auth_error=account_exists');
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute('href', '/api/auth/oauth/google/start');
  await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toHaveAttribute('href', '/api/auth/oauth/github/start');
  await expect(page.locator('#auth-message')).toContainText('Sign in with your password');
  expect(new URL(page.url()).hash).toBe('');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '.local/verification/auth-provider-layout.png', fullPage: true, animations: 'disabled' });
  await page.unroute('**/api/auth/options');
  await page.reload();
  await expect(page.locator('#auth-providers')).toBeHidden();
});

test('an emailed invitation survives sign-in and joins the intended project', async ({ page, request }) => {
  const owner = await account(request, 'Invitation Owner'), guest = await account(request, 'Invited Teammate');
  const headers = { Authorization: `Bearer ${owner.token}` };
  const created = await request.post('/api/projects', { headers, data: { name: 'Invited workspace', slug: `invite-${randomUUID()}` } });
  const { project } = await created.json();
  const invitation = await request.post(`/api/projects/${project._id}/invitations`, { headers, data: { email: guest.email, role: 'viewer' } });
  expect(invitation.status()).toBe(201);
  const { simulatedEmail } = await invitation.json();
  await page.goto(`/#invite=${simulatedEmail.token}`);
  await expect(page.locator('#auth-message')).toContainText('project invitation');
  expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill(guest.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in to your workspace' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Join project', exact: true }).click();
  await expect(page.locator('#account-role')).toHaveText('viewer');
  await expect(page.locator('#project-select option:checked')).toHaveText('Invited workspace');
  expect(await page.evaluate(() => sessionStorage.getItem('status-pulse-invitation'))).toBeNull();
  await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
  await page.locator('#account-name').click();
  await expect(page.getByRole('dialog')).toContainText(guest.email);
  await expect(page.locator('.dialog-header')).toHaveCSS('background-color', await page.getByRole('dialog').evaluate(element => getComputedStyle(element).backgroundColor));
  await page.screenshot({ path: '.local/verification/account-dark-desktop.png', fullPage: true, animations: 'disabled' });
});

test('password recovery gives a neutral acknowledgement and expired links remain safely editable', async ({ page, request }) => {
  const user = await account(request, 'Password Recovery');
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill(user.email);
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('If an account uses this email');
  await page.goto(`/#reset_password=${'A'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByRole('dialog').getByRole('button', { name: 'Show password' }).click();
  await expect(page.locator('#reset-password')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('invalid or expired');
  expect(new URL(page.url()).hash).toBe('');
});

test('public verification links work in an already open status page and retain the dark theme', async ({ page, request }) => {
  const owner = await account(request, 'Public Owner');
  const headers = { Authorization: `Bearer ${owner.token}` }, slug = `public-${randomUUID()}`;
  const { project } = await (await request.post('/api/projects', { headers, data: { name: 'Public workspace', slug, publicEnabled: true } })).json();
  const { service } = await (await request.post(`/api/projects/${project._id}/services`, { headers, data: { name: 'Public API', url: 'https://example.com', publicVisible: true } })).json();
  const signup = await request.post(`/api/public/projects/${slug}/subscriptions`, { data: { email: `${randomUUID()}@example.test`, serviceIds: [service._id] } });
  expect(signup.status()).toBe(202);
  const { simulatedEmail } = await signup.json();
  await page.goto(`/status/${slug}`);
  await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
  await page.goto(`/status/${slug}#verify=${simulatedEmail.verificationToken}`);
  await expect(page.getByLabel('Verification code')).toHaveValue(simulatedEmail.verificationToken);
  await page.getByRole('button', { name: 'Complete simulated verification' }).click();
  await expect(page.locator('#public-message')).toContainText('Subscription activated through simulation');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(new URL(page.url()).hash).toBe('');
  await page.screenshot({ path: '.local/verification/public-dark-desktop.png', fullPage: true, animations: 'disabled' });
});
