'use client';

import { KeyRound, Plus, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Badge, Card, EmptyState, ErrorState, PageHeader, PageLoading } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import { useLive } from '@/lib/live';
import { KeepFocus } from './keep-focus';
import { NoAccess } from './no-access';
import { OwnerDialog } from './owner-dialog';
import { OwnersTabs } from './owners-tabs';
import type { Contract, Owner, Statement, StatementStatus } from './types';
import {
  CONTRACT_STATE_TONES,
  STATUSES,
  STATUS_LABELS,
  STATUS_TONES,
  contractState,
  contractStateWords,
  feeWords,
  localToday,
  statementMonth,
  villaName,
} from './words';

/** The statements of an owner's most recent month, by how far along each is. */
interface Latest {
  periodStart: string;
  counts: Partial<Record<StatementStatus, number>>;
}

function latestByOwner(statements: Statement[]): Map<string, Latest> {
  const out = new Map<string, Latest>();
  for (const statement of statements) {
    const known = out.get(statement.ownerId);
    if (known && known.periodStart > statement.periodStart) continue;
    const latest: Latest =
      known && known.periodStart === statement.periodStart
        ? known
        : { periodStart: statement.periodStart, counts: {} };
    latest.counts[statement.status] = (latest.counts[statement.status] ?? 0) + 1;
    out.set(statement.ownerId, latest);
  }
  return out;
}

/** Current contracts first, then those still to start, then those that have ended. */
function inOrder(contracts: Contract[], today: string): Contract[] {
  const rank = { current: 0, upcoming: 1, ended: 2 };
  return [...contracts].sort(
    (a, b) => rank[contractState(a, today)] - rank[contractState(b, today)],
  );
}

function Villas({ owner, today }: { owner: Owner; today: string }) {
  if (owner.contracts.length === 0) {
    return <span className="text-ink-faint">No contract yet</span>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {inOrder(owner.contracts, today).map((contract) => {
        const state = contractState(contract, today);
        return (
          <li key={contract.id} className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ink">
              <span className="break-words">{villaName(contract)}</span>
              {state !== 'current' && (
                <Badge tone={CONTRACT_STATE_TONES[state]}>
                  {contractStateWords(contract, today)}
                </Badge>
              )}
            </p>
            <p className="text-[13px] text-ink-soft">{feeWords(contract)}</p>
          </li>
        );
      })}
    </ul>
  );
}

function Portal({ owner }: { owner: Owner }) {
  if (!owner.user) return <span className="text-ink-faint">No access</span>;
  if (!owner.active || owner.user.status === 'disabled') {
    return <Badge tone="neutral">Access switched off</Badge>;
  }
  return owner.user.status === 'invited' ? (
    <Badge tone="warning">Invited</Badge>
  ) : (
    <Badge tone="success">
      <KeyRound className="size-3" aria-hidden />
      Has access
    </Badge>
  );
}

/** `latest` is null until the statements have been loaded: "none yet" would not be true then. */
function LatestStatement({ latest }: { latest: Latest | null | undefined }) {
  if (latest === null) {
    return (
      <span className="text-ink-faint">
        <span aria-hidden>–</span>
        <span className="sr-only">Not loaded</span>
      </span>
    );
  }
  if (!latest) return <span className="text-ink-faint">None yet</span>;
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="text-ink">{statementMonth(latest)}</span>
      <span className="flex flex-wrap gap-1">
        {STATUSES.filter((status) => latest.counts[status]).map((status) => (
          <Badge key={status} tone={STATUS_TONES[status]}>
            {(latest.counts[status] ?? 0) > 1 && `${latest.counts[status]} `}
            {(latest.counts[status] ?? 0) > 1
              ? STATUS_LABELS[status].toLowerCase()
              : STATUS_LABELS[status]}
          </Badge>
        ))}
      </span>
    </div>
  );
}

function Contact({ owner }: { owner: Owner }) {
  if (!owner.email && !owner.phone) return <span className="text-ink-faint">Not given</span>;
  return (
    <>
      {owner.email && <p className="break-words text-ink-soft">{owner.email}</p>}
      {owner.phone && <p className="text-ink-soft">{owner.phone}</p>}
    </>
  );
}

const TH = 'px-4 py-2.5 font-medium';

function OwnerTable({
  owners,
  latest,
  today,
}: {
  owners: Owner[];
  latest: Map<string, Latest> | null;
  today: string;
}) {
  const router = useRouter();
  return (
    <Card className="hidden overflow-hidden md:block">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-sunken/60 text-xs text-ink-faint">
              <th scope="col" className={TH}>
                Owner
              </th>
              <th scope="col" className={TH}>
                Contact
              </th>
              <th scope="col" className={TH}>
                Villa and terms
              </th>
              <th scope="col" className={TH}>
                Owner portal
              </th>
              <th scope="col" className={TH}>
                Latest statement
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {owners.map((owner) => {
              const href = `/owners/${owner.id}`;
              return (
                <tr
                  key={owner.id}
                  className="cursor-pointer align-top transition-colors hover:bg-brand-50/60"
                  onClick={() => router.push(href)}
                >
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap items-center gap-2">
                      <Link
                        href={href}
                        className="font-medium text-ink hover:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {owner.name}
                      </Link>
                      {!owner.active && <Badge tone="neutral">Inactive</Badge>}
                    </span>
                    {owner.legalName && (
                      <p className="text-[13px] text-ink-faint">{owner.legalName}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[13px]">
                    <Contact owner={owner} />
                  </td>
                  <td className="px-4 py-3">
                    <Villas owner={owner} today={today} />
                  </td>
                  <td className="px-4 py-3">
                    <Portal owner={owner} />
                  </td>
                  <td className="px-4 py-3">
                    <LatestStatement latest={latest && latest.get(owner.id)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function OwnerCards({
  owners,
  latest,
  today,
}: {
  owners: Owner[];
  latest: Map<string, Latest> | null;
  today: string;
}) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {owners.map((owner) => (
        <li key={owner.id}>
          <Card className="relative p-4 text-sm transition-colors hover:border-line-strong">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/owners/${owner.id}`}
                className="font-medium text-ink after:absolute after:inset-0 after:rounded-xl"
              >
                {owner.name}
              </Link>
              {!owner.active && <Badge tone="neutral">Inactive</Badge>}
            </div>
            <div className="mt-0.5 text-[13px]">
              <Contact owner={owner} />
            </div>
            <div className="mt-3">
              <Villas owner={owner} today={today} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3">
              <div>
                <dt className="mb-1 text-xs text-ink-faint">Owner portal</dt>
                <dd>
                  <Portal owner={owner} />
                </dd>
              </div>
              <div>
                <dt className="mb-1 text-xs text-ink-faint">Latest statement</dt>
                <dd>
                  <LatestStatement latest={latest && latest.get(owner.id)} />
                </dd>
              </div>
            </dl>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function matches(owner: Owner, term: string): boolean {
  const haystack = [
    owner.name,
    owner.legalName,
    owner.email,
    owner.phone,
    ...owner.contracts.flatMap((contract) => [contract.propertyName, contract.unitName]),
  ];
  return haystack.some((text) => text?.toLowerCase().includes(term));
}

/** The people whose villas are managed, with their contract terms and where their statements stand. */
export function OwnersView() {
  const auth = useAuth();
  const router = useRouter();
  const allowed = auth.can('accounting.manage');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);

  const { data, error, isLoading, mutate } = useSWR<{ owners: Owner[] }>(
    allowed ? '/owners' : null,
  );
  const statements = useSWR<{ statements: Statement[] }>(allowed ? '/owner-statements' : null);
  useLive(/^owner/, () => {
    void mutate();
    void statements.mutate();
  });
  const latest = useMemo(
    () => (statements.data ? latestByOwner(statements.data.statements) : null),
    [statements.data],
  );

  if (!allowed) return <NoAccess />;

  const today = localToday();
  const owners = data?.owners ?? [];
  const term = search.trim().toLowerCase();
  const shown = term ? owners.filter((owner) => matches(owner, term)) : owners;
  const add = (
    <Button
      variant="primary"
      icon={<Plus className="size-4" aria-hidden />}
      onClick={() => setAdding(true)}
    >
      Add owner
    </Button>
  );

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Villa owners"
        description="The people whose villas you manage, their contracts, and what each is owed month by month."
        actions={add}
      />
      <OwnersTabs />

      {error && !data ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : isLoading || !data ? (
        <PageLoading label="Loading owners" />
      ) : owners.length === 0 ? (
        <EmptyState
          icon={<Users className="size-5" />}
          title="No villa owners yet"
          description={
            <>
              This is where you keep the people whose villas you manage: the contract with each, the
              costs you charge to them, and a statement every month of what their villa earned and
              what they are owed. Start by adding an owner, then give them a contract for their
              villa.
              {auth.scope('accounting.manage') !== 'all' &&
                ' You see the owners of the properties whose accounts you keep.'}
            </>
          }
          action={add}
        />
      ) : (
        <KeepFocus label="Owners">
          <div className="relative mb-4 sm:max-w-xs">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-faint"
              aria-hidden
            />
            <Input
              type="search"
              aria-label="Search by owner or villa"
              placeholder="Search by owner or villa"
              maxLength={100}
              className="pl-8"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          {shown.length === 0 ? (
            <EmptyState
              icon={<Users className="size-5" />}
              title="No owner matches"
              description="Try another name, or the name of the villa."
              action={<Button onClick={() => setSearch('')}>Clear the search</Button>}
            />
          ) : (
            <>
              <OwnerTable owners={shown} latest={latest} today={today} />
              <OwnerCards owners={shown} latest={latest} today={today} />
            </>
          )}

          {statements.error && !statements.data && (
            <p className="mt-3 text-[13px] text-ink-soft">
              The statements could not be loaded, so the latest statement of each owner is not
              shown.{' '}
              <button
                type="button"
                className="font-medium text-brand-700 hover:underline"
                onClick={() => void statements.mutate()}
              >
                Try again
              </button>
            </p>
          )}
        </KeepFocus>
      )}

      {adding && (
        <OwnerDialog
          onClose={() => setAdding(false)}
          onSaved={(owner) => {
            void mutate();
            // Their page is where the contract is added. Someone who keeps the accounts of
            // particular properties would not find them in the list until they have one.
            router.push(`/owners/${owner.id}`);
          }}
        />
      )}
    </div>
  );
}
