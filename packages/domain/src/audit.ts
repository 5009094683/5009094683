import { auditLog, type DbOrTx } from '@pms/db';
import type { Actor } from './context';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  propertyId?: string | null;
  summary?: string;
  changes?: Record<string, unknown>;
}

const REDACTED_KEYS = new Set([
  'passwordHash',
  'password',
  'totpSecretEnc',
  'recoveryCodeHashes',
  'clientSecretEnc',
  'clientSecret',
  'secretsEnc',
  'idNumberEnc',
  'idNumber',
  'tokenHash',
  'token',
  'keyHash',
  'secret',
]);

/** Removes credentials and identity numbers so they never reach the audit trail. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 6) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(k)
        ? v === null || v === undefined
          ? v
          : '[redacted]'
        : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Shallow before/after comparison keeping only the fields that changed. */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (key === 'updatedAt') continue;
    const from = before[key];
    const to = after[key];
    if (to === undefined) continue;
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      out[key] = { from: redact(from), to: redact(to) };
    }
  }
  return out;
}

/**
 * Appends an audit entry. Call it inside the transaction that makes the
 * change so the record and the change commit or roll back together.
 */
export async function writeAudit(tx: DbOrTx, actor: Actor, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: actor.orgId,
    actorType: actor.type,
    actorUserId: actor.userId ?? null,
    actorLabel: actor.label,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    propertyId: entry.propertyId ?? null,
    summary: entry.summary ?? null,
    changes: entry.changes ? (redact(entry.changes) as Record<string, unknown>) : null,
    ip: actor.ip ?? null,
    requestId: actor.requestId ?? null,
  });
}
