'use client';

import { ArrowLeft, FileSignature, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, Notice, PageLoading } from '@/components/ui/misc';
import { query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLive } from '@/lib/live';
import { ContractCard } from './contract-card';
import { ContractDialog } from './contract-dialog';
import { KeepFocus } from './keep-focus';
import { NoAccess } from './no-access';
import { NotHere } from './not-here';
import { OwnerDialog } from './owner-dialog';
import { PortalAccess } from './portal-access';
import type { Contract, Owner, Statement } from './types';
import { contractState, localToday } from './words';

const LIST = '/owners';

/** What was loaded for another owner must never stand in for this one, not even for a moment. */
const ONE_OWNER = { keepPreviousData: false };

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="break-words text-ink">{children}</dd>
    </div>
  );
}

const notGiven = <span className="text-ink-faint">Not given</span>;

function ContactCard({ owner, onEdit }: { owner: Owner; onEdit: () => void }) {
  const address = [owner.addressLine1, owner.city, owner.state, owner.postalCode]
    .filter(Boolean)
    .join(', ');
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Contact details</h2>
        <Button size="sm" icon={<Pencil className="size-3.5" aria-hidden />} onClick={onEdit}>
          Edit details
        </Button>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Detail label="Email">
          {owner.email ? (
            <a
              href={`mailto:${owner.email}`}
              className="break-words text-brand-700 hover:underline"
            >
              {owner.email}
            </a>
          ) : (
            notGiven
          )}
        </Detail>
        <Detail label="Phone">
          {owner.phone ? (
            <a href={`tel:${owner.phone}`} className="text-brand-700 hover:underline">
              {owner.phone}
            </a>
          ) : (
            notGiven
          )}
        </Detail>
        <Detail label="Address">
          {address ? `${address}${owner.country ? `, ${owner.country}` : ''}` : notGiven}
        </Detail>
        {owner.legalName && <Detail label="Registered name">{owner.legalName}</Detail>}
        {owner.gstin && <Detail label="GSTIN">{owner.gstin}</Detail>}
        <div className="sm:col-span-2">
          <Detail label="Notes for the accounts team">
            {owner.notes ? (
              <span className="whitespace-pre-line">{owner.notes}</span>
            ) : (
              <span className="text-ink-faint">
                None. A good place for how the owner prefers to be paid.
              </span>
            )}
          </Detail>
        </div>
      </dl>
    </Card>
  );
}

/** Current contracts first, then those still to start, then those that have ended, newest first. */
function inOrder(contracts: Contract[], today: string): Contract[] {
  const rank = { current: 0, upcoming: 1, ended: 2 };
  return [...contracts].sort(
    (a, b) =>
      rank[contractState(a, today)] - rank[contractState(b, today)] ||
      (a.startsOn < b.startsOn ? 1 : a.startsOn > b.startsOn ? -1 : 0),
  );
}

/** One owner: how to reach them, their access to the portal, and their contracts with all that hangs on them. */
export function OwnerDetail({ ownerId }: { ownerId: string }) {
  const auth = useAuth();
  const allowed = auth.can('accounting.manage');
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);

  const {
    data: owner,
    error,
    isLoading,
    mutate,
  } = useSWR<Owner>(allowed ? `/owners/${ownerId}` : null, ONE_OWNER);
  const statements = useSWR<{ statements: Statement[] }>(
    allowed ? `/owner-statements${query({ ownerId })}` : null,
    ONE_OWNER,
  );
  useLive(/^owner/, () => {
    void mutate();
    void statements.mutate();
  });

  if (!allowed) return <NoAccess />;
  const scoped = auth.scope('accounting.manage') !== 'all';
  if (error && !owner) {
    return (
      <NotHere
        error={error}
        onRetry={() => void mutate()}
        title="This owner is not here"
        missing={
          scoped
            ? 'There is no owner at this address among those you can see. You see the owners of the properties whose accounts you keep.'
            : 'There is no owner at this address. The link may be an old one.'
        }
        refused="You do not have access to this owner. Ask an organisation admin if you need it."
        back={{ href: LIST, label: 'Back to villa owners' }}
      />
    );
  }
  if (isLoading || !owner) return <PageLoading label="Loading the owner" />;

  const today = localToday();
  const contracts = inOrder(owner.contracts, today);
  const addContract = (
    <Button
      variant="primary"
      size="sm"
      icon={<Plus className="size-4" aria-hidden />}
      onClick={() => setAdding(true)}
    >
      Add contract
    </Button>
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <div>
        <Link
          href={LIST}
          className="inline-flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Villa owners
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight break-words text-ink">
            {owner.name}
          </h1>
          {!owner.active && <Badge tone="neutral">Inactive</Badge>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ContactCard owner={owner} onEdit={() => setEditing(true)} />
        <PortalAccess owner={owner} onChanged={() => void mutate()} />
      </div>

      <KeepFocus label="Contracts" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-ink">Contracts</h2>
            {scoped && (
              <p className="text-[13px] text-ink-faint">
                You see the contracts for the properties whose accounts you keep.
              </p>
            )}
          </div>
          {contracts.length > 0 && addContract}
        </div>

        {statements.error && !statements.data && (
          <Notice tone="warning">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <p>The statements could not be loaded, so none are listed below.</p>
              <Button
                size="sm"
                loading={statements.isValidating}
                onClick={() => void statements.mutate()}
              >
                Try again
              </Button>
            </div>
          </Notice>
        )}

        {contracts.length === 0 ? (
          <Card>
            <EmptyState
              icon={<FileSignature className="size-5" />}
              title="No contract yet"
              description={`A contract says which villa is ${owner.name}\u2019s, how they are paid for it, and when they may stay there themselves. Costs and monthly statements hang on it.`}
              action={addContract}
            />
          </Card>
        ) : (
          contracts.map((contract) => (
            <ContractCard
              key={contract.id}
              owner={owner}
              contract={contract}
              statements={statements.data?.statements ?? []}
              statementsLoad={statements.data ? 'ready' : statements.error ? 'failed' : 'loading'}
              today={today}
              onChanged={() => void mutate()}
              onStatementsChanged={() => void statements.mutate()}
            />
          ))
        )}
      </KeepFocus>

      {editing && (
        <OwnerDialog
          owner={owner}
          onClose={() => setEditing(false)}
          onSaved={() => void mutate()}
        />
      )}
      {adding && (
        <ContractDialog
          owner={owner}
          onClose={() => setAdding(false)}
          onSaved={() => void mutate()}
        />
      )}
    </div>
  );
}
