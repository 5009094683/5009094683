import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@pms/db';
import type { Mailer } from './mailer';
import { uuidArray } from './sqlx';

/** An alert older than this when the mail server comes back is no longer news worth an email. */
const FRESH_HOURS = 24;

interface Pending {
  id: string;
  org_id: string;
  severity: 'critical' | 'warning';
  title: string;
  body: string | null;
  property: string | null;
  recipients: string[];
  [key: string]: unknown;
}

/**
 * Emails new alerts to the addresses the organisation has named, so that an
 * overbooking or a broken connection is noticed when nobody has the back
 * office open. One email for each organisation each run, however many alerts
 * there are. Each alert is emailed once; if the mail server is down it is
 * tried again on the next run.
 */
export async function emailNewAlerts(
  db: DbOrTx,
  mailer: Mailer,
  options: { webUrl: string; now?: Date },
): Promise<number> {
  if (!mailer.configured) return 0;
  const now = (options.now ?? new Date()).toISOString();
  // Claimed first, so two workers never send the same alert.
  const { rows } = await db.execute<Pending>(sql`
    UPDATE alerts a SET notified_at = ${now}::timestamptz
    FROM organizations o
    WHERE o.id = a.org_id AND a.id IN (
      SELECT x.id FROM alerts x JOIN organizations xo ON xo.id = x.org_id
      WHERE x.notified_at IS NULL AND x.status = 'open' AND x.severity IN ('critical', 'warning')
        AND x.created_at > ${now}::timestamptz - make_interval(hours => ${FRESH_HOURS})
        AND jsonb_array_length(coalesce(xo.settings->'alertEmails', '[]'::jsonb)) > 0
      ORDER BY x.created_at
      LIMIT 100
      FOR UPDATE OF x SKIP LOCKED
    )
    RETURNING a.id, a.org_id, a.severity, a.title, a.body,
      (SELECT name FROM properties p WHERE p.id = a.property_id) AS property,
      o.settings->'alertEmails' AS recipients
  `);
  const byOrg = new Map<string, Pending[]>();
  for (const row of rows) byOrg.set(row.org_id, [...(byOrg.get(row.org_id) ?? []), row]);
  let sent = 0;
  for (const list of byOrg.values()) {
    const urgent = list.filter((a) => a.severity === 'critical');
    const first = urgent[0] ?? list[0]!;
    const subject =
      list.length === 1
        ? `${first.severity === 'critical' ? 'Urgent: ' : ''}${first.title}`
        : `${urgent.length > 0 ? 'Urgent: ' : ''}${list.length} things need attention`;
    const text = [
      ...[...urgent, ...list.filter((a) => a.severity !== 'critical')].flatMap((a) => [
        `${a.severity === 'critical' ? 'URGENT' : 'Warning'}: ${a.title}`,
        ...(a.property ? [`Property: ${a.property}`] : []),
        ...(a.body ? [a.body] : []),
        '',
      ]),
      `Open the property management system to deal with ${list.length === 1 ? 'it' : 'them'}: ${options.webUrl}`,
    ].join('\n');
    try {
      await mailer.send({ to: first.recipients, subject, text });
      sent += list.length;
    } catch {
      // Not sent: hand the alerts back so the next run tries again.
      await db.execute(sql`
        UPDATE alerts SET notified_at = NULL WHERE id = ANY(${uuidArray(list.map((a) => a.id))})
      `);
    }
  }
  return sent;
}
