import { test as setup } from '@playwright/test';
import { AUTH_STATE } from '../env';
import { signIn } from '../helpers';

// Signs in once and saves the session, so the other specs start signed in
// instead of repeating the sign-in form in every test.
setup('sign in as the demo admin', async ({ page }) => {
  await signIn(page);
  await page.context().storageState({ path: AUTH_STATE });
});
