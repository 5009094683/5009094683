import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, emptyJson, id, timestamptz, updatedAt } from './_shared';
import {
  ACTOR_TYPES,
  ROLES,
  USER_STATUSES,
  sqlList,
  type ActorType,
  type Role,
  type UserStatus,
} from './enums';
import { properties } from './inventory';

export interface OrgSettings {
  /** Require every user to enrol a second factor before using the back office. */
  requireTwoFactor?: boolean;
  /** Days after check-out before guest identity documents are erased. */
  guestIdRetentionDays?: number;
  /** Days after last stay before a guest profile is anonymised. 0 disables. */
  guestProfileRetentionDays?: number;
  alertEmails?: string[];
}

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  defaultCurrency: text('default_currency').notNull().default('INR'),
  defaultTimezone: text('default_timezone').notNull().default('Asia/Kolkata'),
  settings: jsonb('settings').$type<OrgSettings>().notNull().default(emptyJson),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    name: text('name').notNull(),
    status: text('status').$type<UserStatus>().notNull().default('active'),
    /** scrypt hash; null for accounts that only sign in through single sign-on. */
    passwordHash: text('password_hash'),
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabledAt: timestamptz('totp_enabled_at'),
    /** Last accepted TOTP time step, so a code cannot be replayed. */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    recoveryCodeHashes: jsonb('recovery_code_hashes')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    lastLoginAt: timestamptz('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    index('users_org_idx').on(t.orgId),
    check('users_status_check', sql.raw(`status IN (${sqlList(USER_STATUSES)})`)),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    /** SHA-256 of the cookie token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authMethod: text('auth_method').$type<'password' | 'oidc'>().notNull(),
    /** Password accepted but second factor still outstanding. */
    mfaPending: boolean('mfa_pending').notNull().default(false),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

/** Single-use links: invitations and password resets. Only the hash of the token is stored. */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'invite' | 'password_reset'>().notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('user_tokens_token_hash_key').on(t.tokenHash),
    index('user_tokens_user_idx').on(t.userId),
  ],
);

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<Role>().notNull(),
    /** Null grants the role on every property of the organisation. */
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('role_assignments_unique').on(t.userId, t.role, t.propertyId).nullsNotDistinct(),
    index('role_assignments_user_idx').on(t.userId),
    check('role_assignments_role_check', sql.raw(`role IN (${sqlList(ROLES)})`)),
  ],
);

export const oidcProviders = pgTable(
  'oidc_providers',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    issuer: text('issuer').notNull(),
    clientId: text('client_id').notNull(),
    clientSecretEnc: text('client_secret_enc'),
    scopes: text('scopes').notNull().default('openid email profile'),
    /**
     * Email domains this provider may vouch for. A sign-in whose email is
     * outside the list is refused; an empty list refuses every sign-in.
     */
    allowedEmailDomains: jsonb('allowed_email_domains')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Create a user on first sign-in instead of requiring an existing account. */
    autoProvision: boolean('auto_provision').notNull().default(false),
    defaultRole: text('default_role').$type<Role>(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('oidc_providers_slug_key').on(t.slug)],
);

export const userIdentities = pgTable(
  'user_identities',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => oidcProviders.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    email: citext('email'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('user_identities_provider_subject_key').on(t.providerId, t.subject)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').notNull(),
    at: timestamptz('at').notNull().defaultNow(),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorUserId: uuid('actor_user_id'),
    /** Email, API key name, channel code or component name: readable without joins. */
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    propertyId: uuid('property_id'),
    summary: text('summary'),
    changes: jsonb('changes').$type<Record<string, unknown>>(),
    ip: text('ip'),
    requestId: text('request_id'),
  },
  (t) => [
    index('audit_log_org_at_idx').on(t.orgId, t.at.desc()),
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_actor_idx').on(t.actorUserId, t.at.desc()),
    check('audit_log_actor_type_check', sql.raw(`actor_type IN (${sqlList(ACTOR_TYPES)})`)),
  ],
);
