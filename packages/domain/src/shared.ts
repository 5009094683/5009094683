/**
 * The part of the domain package that is safe to load in a browser: pure
 * functions and constants with no database or Node.js dependencies. The web
 * apps import from here; everything else they take as types only.
 */
export * from './dates';
export {
  PERMISSIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  can,
  canAcrossOrganisation,
  propertyScope,
  type Permission,
} from './auth/permissions';
export { BLOCK_KIND_LABELS } from './block-labels';
export type { DomainErrorCode } from './errors';
