import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Business, BusinessConfigError, parseBusiness } from './schema';

/** Reads a settings file such as config/business.ts and checks every value in it. */
export async function loadBusiness(file: string): Promise<Business> {
  const path = resolve(file);
  if (!existsSync(path)) {
    throw new BusinessConfigError(`Settings file not found: ${path}`);
  }
  const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  if (module.default === undefined) {
    throw new BusinessConfigError(`${path} must end with "export default defineBusiness({ ... })"`);
  }
  return parseBusiness(module.default, path);
}
