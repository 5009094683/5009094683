'use client';

import { KeyRound, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import useSWR, { type KeyedMutator } from 'swr';
import type { AuditPage } from '@/components/settings/audit-table';
import { ConfirmDialog } from '@/components/settings/confirm-dialog';
import { grantSummaries } from '@/components/settings/roles';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import type { Property } from '@/lib/types';
import { ApiKeyDialog } from './api-key-dialog';
import { useNow, useReturnFocus } from './focus';
import { Code, HowTo } from './how-to';
import { SecretDialog } from './secret-dialog';
import type { ApiKey, ApiKeysAnswer, CreatedApiKey } from './types';
import { KEY_STATE_LABELS, formatDayOf, formatWhen, keyState, type KeyState } from './words';

type Open =
  { kind: 'new' } | { kind: 'created'; created: CreatedApiKey } | { kind: 'revoke'; key: ApiKey };

const STATE_TONES: Record<KeyState, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  expired: 'warning',
  revoked: 'neutral',
};

/** A key with everything the list says about it worked out once, for the table and the cards. */
interface ListedKey {
  key: ApiKey;
  state: KeyState;
  /** What the key may do, one line for each role. */
  may: string[];
  createdBy: string | undefined;
}

function StateBadge({ item }: { item: ListedKey }) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge tone={STATE_TONES[item.state]}>{KEY_STATE_LABELS[item.state]}</Badge>
      {item.key.revokedAt && (
        <span className="text-xs whitespace-nowrap text-ink-faint">
          {formatDayOf(item.key.revokedAt)}
        </span>
      )}
    </div>
  );
}

function May({ item }: { item: ListedKey }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {item.may.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function LastUsed({ item, now }: { item: ListedKey; now: Date }) {
  const { lastUsedAt } = item.key;
  if (!lastUsedAt) return <span className="text-ink-faint">Never</span>;
  return <span title={new Date(lastUsedAt).toLocaleString()}>{formatWhen(lastUsedAt, now)}</span>;
}

function Expiry({ item }: { item: ListedKey }) {
  const { expiresAt } = item.key;
  if (!expiresAt) return <span className="text-ink-faint">Does not expire</span>;
  return <span title={new Date(expiresAt).toLocaleString()}>{formatDayOf(expiresAt)}</span>;
}

/** The start of the key, which is all of it that is kept: enough to tell two keys apart. */
function KeyHint({ prefix }: { prefix: string }) {
  return (
    <p className="font-mono text-xs text-ink-faint">
      <span className="sr-only">Starts with </span>
      {prefix}…
    </p>
  );
}

function KeysTable({
  working,
  dead,
  now,
  onRevoke,
}: {
  working: ListedKey[];
  dead: ListedKey[];
  now: Date;
  onRevoke: (key: ApiKey) => void;
}) {
  const row = (item: ListedKey) => {
    const off = item.state !== 'active';
    return (
      <tr key={item.key.id} className={cn('align-top', off && 'text-ink-faint')}>
        <td className="px-4 py-3">
          <p className={cn('font-medium break-words', off ? 'text-ink-soft' : 'text-ink')}>
            {item.key.name}
          </p>
          <KeyHint prefix={item.key.prefix} />
        </td>
        <td className={cn('px-4 py-3', !off && 'text-ink-soft')}>
          <May item={item} />
        </td>
        <td className={cn('px-4 py-3', !off && 'text-ink-soft')}>
          <p className="whitespace-nowrap">{formatDayOf(item.key.createdAt)}</p>
          {item.createdBy && (
            <p className="max-w-44 truncate text-[13px] text-ink-faint" title={item.createdBy}>
              by {item.createdBy}
            </p>
          )}
        </td>
        <td className={cn('px-4 py-3 whitespace-nowrap', !off && 'text-ink-soft')}>
          <LastUsed item={item} now={now} />
        </td>
        <td className={cn('px-4 py-3 whitespace-nowrap', !off && 'text-ink-soft')}>
          <Expiry item={item} />
        </td>
        <td className="px-4 py-3">
          <StateBadge item={item} />
        </td>
        <td className="px-4 py-2 text-right whitespace-nowrap">
          {item.state === 'active' && (
            <Button
              size="sm"
              variant="danger-ghost"
              aria-label={`Revoke ${item.key.name}`}
              onClick={() => onRevoke(item.key)}
            >
              Revoke
            </Button>
          )}
        </td>
      </tr>
    );
  };

  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
            <th scope="col" className="px-4 py-2.5 font-medium">
              Key
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              What it may do
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Created
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Last used
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Expires
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Status
            </th>
            <th scope="col" className="px-4 py-2.5">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        {working.length > 0 && <tbody className="divide-y divide-line">{working.map(row)}</tbody>}
        {dead.length > 0 && (
          <tbody className="divide-y divide-line border-t border-line">
            <tr>
              <th
                scope="rowgroup"
                colSpan={7}
                className="bg-sunken/60 px-4 py-2 text-xs font-medium text-ink-faint"
              >
                No longer working
              </th>
            </tr>
            {dead.map(row)}
          </tbody>
        )}
      </table>
    </Card>
  );
}

function KeyCards({
  working,
  dead,
  now,
  onRevoke,
}: {
  working: ListedKey[];
  dead: ListedKey[];
  now: Date;
  onRevoke: (key: ApiKey) => void;
}) {
  const card = (item: ListedKey) => {
    const off = item.state !== 'active';
    return (
      <li key={item.key.id}>
        <Card className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className={cn('font-medium break-words', off ? 'text-ink-soft' : 'text-ink')}>
                {item.key.name}
              </h3>
              <KeyHint prefix={item.key.prefix} />
            </div>
            <StateBadge item={item} />
          </div>
          <div className={cn('mt-2 text-sm', off ? 'text-ink-faint' : 'text-ink-soft')}>
            <May item={item} />
          </div>
          <dl
            className={cn(
              'mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm',
              off ? 'text-ink-faint' : 'text-ink-soft',
            )}
          >
            <dt className="text-[13px] text-ink-faint">Created</dt>
            <dd className="min-w-0 break-words">
              {formatDayOf(item.key.createdAt)}
              {item.createdBy && ` by ${item.createdBy}`}
            </dd>
            <dt className="text-[13px] text-ink-faint">Last used</dt>
            <dd>
              <LastUsed item={item} now={now} />
            </dd>
            <dt className="text-[13px] text-ink-faint">Expires</dt>
            <dd>
              <Expiry item={item} />
            </dd>
          </dl>
          {item.state === 'active' && (
            <div className="mt-2 -mb-1 -ml-2">
              <Button
                size="sm"
                variant="danger-ghost"
                aria-label={`Revoke ${item.key.name}`}
                onClick={() => onRevoke(item.key)}
              >
                Revoke
              </Button>
            </div>
          )}
        </Card>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {working.length > 0 && <ul className="flex flex-col gap-3">{working.map(card)}</ul>}
      {dead.length > 0 && (
        <>
          <h2 className="px-1 pt-1 text-xs font-medium text-ink-faint">No longer working</h2>
          <ul className="flex flex-col gap-3">{dead.map(card)}</ul>
        </>
      )}
    </div>
  );
}

/** The keys other systems call the API with: the list, creating one and revoking one. */
export function ApiKeysTab({
  data,
  mutate,
  properties,
  adding,
  onAdd,
  onAddingDone,
}: {
  data: ApiKeysAnswer;
  mutate: KeyedMutator<ApiKeysAnswer>;
  properties: Property[];
  /** The page's "New API key" button was pressed. */
  adding: boolean;
  onAdd: () => void;
  onAddingDone: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const now = useNow(30_000);
  const region = useRef<HTMLElement>(null);
  const [opened, setOpened] = useState<Open | null>(null);
  const open: Open | null = adding ? { kind: 'new' } : opened;
  useReturnFocus(open !== null, region);
  const close = () => {
    setOpened(null);
    onAddingDone();
  };

  // The answer does not say who created a key; the audit trail does, for those who may read it.
  const audit = useSWR<AuditPage>(
    data.keys.length > 0 && auth.canOrgWide('audit.read')
      ? `/audit${query({ entityType: 'api_key', actionPrefix: 'api_key.created', limit: 200 })}`
      : null,
  );
  const creators = new Map(audit.data?.entries.map((entry) => [entry.entityId, entry.actorLabel]));

  const listed: ListedKey[] = data.keys.map((key) => ({
    key,
    state: keyState(key, now),
    may: grantSummaries(key.grants, [], properties),
    createdBy: creators.get(key.id),
  }));
  const working = listed.filter((item) => item.state === 'active');
  const dead = listed.filter((item) => item.state !== 'active');
  const revoke = (key: ApiKey) => setOpened({ kind: 'revoke', key });

  return (
    <section ref={region} tabIndex={-1} aria-label="API keys" className="@container outline-none">
      {listed.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="size-5" />}
          title="No API keys"
          description="An API key lets another system, such as a revenue tool or an accounting export, read and change things here without a person signing in. Create one key for each system, so that each can be stopped on its own."
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={onAdd}>
              New API key
            </Button>
          }
        />
      ) : (
        <>
          <div className="@4xl:hidden">
            <KeyCards working={working} dead={dead} now={now} onRevoke={revoke} />
          </div>
          <div className="hidden @4xl:block">
            <KeysTable working={working} dead={dead} now={now} onRevoke={revoke} />
          </div>
        </>
      )}

      <HowTo title="How to use a key">
        <p>The other system sends the key with every request, in this header:</p>
        <pre className="scrollbar-thin overflow-x-auto rounded-md bg-sunken px-3 py-2 font-mono text-[13px] text-ink">
          Authorization: Bearer pms_...
        </pre>
        <p>
          Each key may make 600 requests a minute, unless the limit was changed where this system is
          installed. Beyond that the answer is <Code>429</Code>, with a <Code>Retry-After</Code>{' '}
          header that says how long to wait.
        </p>
        <p>
          A key does what its roles allow and nothing more, and everything it changes is in the
          audit trail under the key&rsquo;s name.
        </p>
      </HowTo>

      {open?.kind === 'new' && (
        <ApiKeyDialog
          roles={data.roles}
          properties={properties}
          onClose={close}
          onCreated={(created) => {
            onAddingDone();
            setOpened({ kind: 'created', created });
            void mutate(
              (current) => current && { ...current, keys: [created.apiKey, ...current.keys] },
              { revalidate: false },
            );
            void audit.mutate();
          }}
        />
      )}
      {open?.kind === 'created' && (
        <SecretDialog
          title={`“${open.created.apiKey.name}” is ready`}
          label="API key"
          name="API key"
          value={open.created.key}
          onClose={close}
        >
          Give this key to the system that will use it. It sends the key with every request.
        </SecretDialog>
      )}
      {open?.kind === 'revoke' && (
        <ConfirmDialog
          title={`Revoke “${open.key.name}”?`}
          confirmLabel="Revoke key"
          onClose={close}
          onConfirm={async () => {
            const revoked = await api<ApiKey>(`/api-keys/${open.key.id}`, { method: 'DELETE' });
            // In the list before the dialog closes, so the keyboard is not handed back to a
            // Revoke button that is about to go.
            await mutate(
              (current) =>
                current && {
                  ...current,
                  keys: current.keys.map((key) => (key.id === revoked.id ? revoked : key)),
                },
              { revalidate: false },
            );
            toast.success(`“${revoked.name}” revoked`, 'Requests made with it are refused.');
            close();
          }}
        >
          <p>
            Whatever uses this key stops working at once: every request made with it is refused.
          </p>
          <p className="mt-2">
            A revoked key cannot be switched back on. To let that system in again, create a new key.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
