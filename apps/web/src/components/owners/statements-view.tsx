'use client';

import { FilePlus2, FileText } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  PageLoading,
} from '@/components/ui/misc';
import { query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { plural } from '@/lib/format';
import { useLive } from '@/lib/live';
import { KeepFocus } from './keep-focus';
import { money } from './money';
import { NoAccess } from './no-access';
import { OwnersTabs } from './owners-tabs';
import { PrepareDialog, type PreparableContract } from './prepare-dialog';
import type { Owner, Statement } from './types';
import {
  STATUSES,
  STATUS_LABELS,
  STATUS_TONES,
  formatDayOf,
  isMonth,
  monthKey,
  monthLabel,
  statementMonth,
  villaName,
} from './words';

/** The most the server lists at once. */
const LIMIT = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a statement stands, in a few words: when it was issued or paid. */
function progress(statement: Statement): string {
  if (statement.status === 'paid' && statement.paidAt) {
    return `Paid ${formatDayOf(statement.paidAt)}`;
  }
  if (statement.status === 'issued' && statement.issuedAt) {
    return `Issued ${formatDayOf(statement.issuedAt)}, not paid yet`;
  }
  return 'Not issued yet';
}

const TH = 'px-4 py-2.5 font-medium';

function StatementTable({ statements }: { statements: Statement[] }) {
  const router = useRouter();
  return (
    <Card className="hidden overflow-hidden md:block">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-sunken/60 text-xs text-ink-faint">
              <th scope="col" className={TH}>
                Month
              </th>
              <th scope="col" className={TH}>
                Owner
              </th>
              <th scope="col" className={TH}>
                Villa
              </th>
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={TH}>
                Number
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Payable to the owner
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {statements.map((statement) => {
              const href = `/owners/statements/${statement.id}`;
              return (
                <tr
                  key={statement.id}
                  className="cursor-pointer align-top transition-colors hover:bg-brand-50/60"
                  onClick={() => router.push(href)}
                >
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Link
                      href={href}
                      className="font-medium text-ink hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {statementMonth(statement)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{statement.ownerName}</td>
                  <td className="px-4 py-3 text-ink-soft">{villaName(statement)}</td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONES[statement.status]}>
                      {STATUS_LABELS[statement.status]}
                    </Badge>
                    <p className="mt-0.5 text-[13px] text-ink-faint">{progress(statement)}</p>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-ink-soft">
                    {statement.number ?? <span className="text-ink-faint">None yet</span>}
                  </td>
                  <td className="tabular px-4 py-3 text-right font-medium whitespace-nowrap text-ink">
                    {money(statement.payout, statement.currency)}
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

function StatementCards({ statements }: { statements: Statement[] }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {statements.map((statement) => (
        <li key={statement.id}>
          <Card className="relative p-4 text-sm transition-colors hover:border-line-strong">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link
                  href={`/owners/statements/${statement.id}`}
                  className="font-medium text-ink after:absolute after:inset-0 after:rounded-xl"
                >
                  {statementMonth(statement)}
                </Link>
                <p className="break-words text-ink-soft">{statement.ownerName}</p>
                <p className="text-[13px] break-words text-ink-faint">{villaName(statement)}</p>
              </div>
              <Badge tone={STATUS_TONES[statement.status]}>{STATUS_LABELS[statement.status]}</Badge>
            </div>
            <div className="mt-3 flex items-end justify-between gap-3 border-t border-line pt-3">
              <p className="text-[13px] text-ink-faint">
                {statement.number && <span className="block">{statement.number}</span>}
                {progress(statement)}
              </p>
              <p className="tabular shrink-0 font-medium text-ink">
                {money(statement.payout, statement.currency)}
              </p>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

/**
 * The filters live in the address, so the list comes back as it was left
 * after opening a statement, and a filtered list can be sent to someone.
 */
function StatementList() {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [preparing, setPreparing] = useState(false);

  const month = isMonth(params.get('month')) ? (params.get('month') ?? '') : '';
  const status = STATUSES.find((value) => value === params.get('status')) ?? '';
  const ownerId = UUID.test(params.get('owner') ?? '') ? (params.get('owner') ?? '') : '';
  const propertyId = UUID.test(params.get('property') ?? '') ? (params.get('property') ?? '') : '';
  const filtered = month !== '' || status !== '' || ownerId !== '' || propertyId !== '';

  // The address is read and written directly, not through the router: two changes made one
  // straight after the other then both hold, and no request goes to the server for the page.
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    const text = next.toString();
    window.history.replaceState(null, '', text ? `${pathname}?${text}` : pathname);
  };
  const clear = () => window.history.replaceState(null, '', pathname);

  const owners = useSWR<{ owners: Owner[] }>('/owners');
  // The server narrows by owner and by status; the month and the property are narrowed here.
  const { data, error, isLoading, mutate } = useSWR<{ statements: Statement[] }>(
    `/owner-statements${query({ ownerId, status })}`,
    // Statements kept from another filter would stay on screen if this request failed.
    { keepPreviousData: false },
  );
  useLive(/^owner/, () => {
    void mutate();
    void owners.mutate();
  });

  const all = useMemo(() => data?.statements ?? [], [data]);
  const shown = all.filter(
    (statement) =>
      (month === '' || monthKey(statement.periodStart) === month) &&
      (propertyId === '' || statement.propertyId === propertyId),
  );

  const months = useMemo(() => {
    const found = new Set(all.map((statement) => monthKey(statement.periodStart)));
    if (month) found.add(month);
    return [...found].sort().reverse();
  }, [all, month]);
  const properties = useMemo(() => {
    const found = new Map<string, string>();
    for (const owner of owners.data?.owners ?? []) {
      for (const contract of owner.contracts) found.set(contract.propertyId, contract.propertyName);
    }
    for (const statement of all) found.set(statement.propertyId, statement.propertyName);
    return [...found].sort((a, b) => a[1].localeCompare(b[1]));
  }, [owners.data, all]);
  const contracts = useMemo<PreparableContract[]>(
    () =>
      (owners.data?.owners ?? []).flatMap((owner) =>
        owner.contracts.map((contract) => ({ contract, ownerName: owner.name })),
      ),
    [owners.data],
  );

  const prepare = contracts.length > 0 && (
    <Button
      variant="primary"
      icon={<FilePlus2 className="size-4" aria-hidden />}
      onClick={() => setPreparing(true)}
    >
      Prepare a statement
    </Button>
  );

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Villa owners"
        description="The people whose villas you manage, their contracts, and what each is owed month by month."
        actions={prepare}
      />
      <OwnersTabs />

      <KeepFocus label="Statements">
        <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <Select
            aria-label="Month"
            className="sm:w-auto"
            value={month}
            onChange={(event) => change('month', event.target.value)}
          >
            <option value="">All months</option>
            {months.map((value) => (
              <option key={value} value={value}>
                {monthLabel(value)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Status"
            className="sm:w-auto"
            value={status}
            onChange={(event) => change('status', event.target.value)}
          >
            <option value="">Any status</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Owner"
            className="sm:w-auto sm:max-w-56"
            value={ownerId}
            onChange={(event) => change('owner', event.target.value)}
          >
            <option value="">All owners</option>
            {(owners.data?.owners ?? []).map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Property"
            className="sm:w-auto sm:max-w-56"
            value={propertyId}
            onChange={(event) => change('property', event.target.value)}
          >
            <option value="">All properties</option>
            {properties.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
          {filtered && (
            <Button variant="ghost" className="col-span-2 sm:col-span-1" onClick={clear}>
              Clear filters
            </Button>
          )}
        </div>

        {error && !data ? (
          <ErrorState error={error} onRetry={() => void mutate()} />
        ) : isLoading || !data ? (
          <PageLoading label="Loading statements" />
        ) : shown.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={<FileText className="size-5" />}
              title="No statement matches"
              description="Nothing has been prepared for this choice of month, status, owner and property."
              action={<Button onClick={clear}>Clear filters</Button>}
            />
          ) : (
            <EmptyState
              icon={<FileText className="size-5" />}
              title="No statements yet"
              description={
                contracts.length > 0 ? (
                  <>
                    A statement shows what a villa earned in a month and what its owner is owed. At
                    the start of each month a draft for the month just ended is prepared
                    automatically for every contract, ready for you to check and issue. You can also
                    prepare one now, one villa at a time.
                  </>
                ) : (
                  <>
                    A statement shows what a villa earned in a month and what its owner is owed. It
                    is worked out from a contract, so start under Owners: add an owner and give them
                    a contract for their villa. From then on a draft is prepared automatically at
                    the start of each month.
                  </>
                )
              }
              action={
                contracts.length > 0 ? (
                  prepare
                ) : (
                  <Link
                    href="/owners"
                    className="text-sm font-medium text-brand-700 hover:underline"
                  >
                    Go to owners
                  </Link>
                )
              }
            />
          )
        ) : (
          <>
            {all.length >= LIMIT && (
              <Notice tone="warning" className="mb-3">
                Only the {LIMIT} most recent statements are listed. Choose an owner or a status to
                reach older ones.
              </Notice>
            )}
            <StatementTable statements={shown} />
            <StatementCards statements={shown} />
            <p className="mt-2 text-[13px] text-ink-faint">
              {plural(shown.length, 'statement')}
              {auth.scope('accounting.manage') !== 'all' &&
                ', for the properties whose accounts you keep'}
              .
            </p>
          </>
        )}
      </KeepFocus>

      {preparing && (
        <PrepareDialog
          contracts={contracts}
          onClose={() => setPreparing(false)}
          onPrepared={(statement) => router.push(`/owners/statements/${statement.id}`)}
        />
      )}
    </div>
  );
}

/** Statements across all owners, to see what is still to check, to issue and to pay. */
export function StatementsView() {
  const auth = useAuth();
  if (!auth.can('accounting.manage')) return <NoAccess />;
  return (
    <Suspense fallback={<PageLoading />}>
      <StatementList />
    </Suspense>
  );
}
