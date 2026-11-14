import { expect, test } from '@playwright/test';
import { DEMO_LOGIN } from '../env';
import { signIn } from '../helpers';

test.describe('signing in', () => {
  // These tests are about the sign-in form itself, so they start signed out.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sends a signed-out visitor to sign in, then back to the page they asked for', async ({
    page,
  }) => {
    await page.goto('/reservations');
    await page.waitForURL(/\/login\?returnTo=%2Freservations/);
    await page.getByLabel('Email').fill(DEMO_LOGIN.email);
    await page.getByLabel('Password').fill(DEMO_LOGIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/reservations');
    await expect(page.getByRole('heading', { name: 'Reservations' })).toBeVisible();
  });

  test('explains a wrong password without saying which part was wrong', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(DEMO_LOGIN.email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Next.js renders its own (empty) alert region for route announcements.
    await expect(page.getByRole('alert').filter({ hasText: 'Invalid' })).toHaveText(
      'Invalid email or password',
    );
    await expect(page).toHaveURL(/\/login/);
  });

  test('signs out and protects the pages again', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL('**/login');
    await page.goto('/calendar');
    await page.waitForURL(/\/login/);
  });
});
