import { dropStaleTestDatabases, prepareTestTemplate } from '@pms/db/testing';

export default async function globalSetup(): Promise<() => Promise<void>> {
  await dropStaleTestDatabases();
  await prepareTestTemplate();
  return async () => {
    await dropStaleTestDatabases();
  };
}
