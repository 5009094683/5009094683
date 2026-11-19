'use client';

import {
  ArrowLeft,
  BadgeCheck,
  Download,
  MoreHorizontal,
  PenLine,
  Printer,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { todayIn } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Badge, Menu, MenuItem, Notice, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate, formatDateTime } from '@/lib/format';
import { useAction, useProperties } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import { AdjustmentsDialog } from './adjustments-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { downloadStatement } from './download';
import { KeepFocus } from './keep-focus';
import { money } from './money';
import { NoAccess } from './no-access';
import { NotHere } from './not-here';
import { PaidDialog } from './paid-dialog';
import { StatementDocument } from './statement-document';
import type { IssuedStatement, Owner, Statement } from './types';
import {
  STATUS_LABELS,
  STATUS_TONES,
  localToday,
  monthKey,
  shiftMonth,
  statementMonth,
  villaName,
} from './words';

const LIST = '/owners/statements';

/** What was loaded for another statement must never stand in for this one, not even for a moment. */
const ONE_DOCUMENT = { keepPreviousData: false };

type Open = 'adjust' | 'issue' | 'paid' | 'delete' | null;

/** One owner statement as the accounts team works on it: the document, and what can be done with it. */
export function StatementView({ statementId }: { statementId: string }) {
  const auth = useAuth();
  const router = useRouter();
  const toast = useToast();
  const allowed = auth.can('accounting.manage');
  const [open, setOpen] = useState<Open>(null);
  /** Set when a statement was issued but the owner was not emailed, so that it is not missed. */
  const [notEmailed, setNotEmailed] = useState<string | null>(null);

  const path = `/owner-statements/${statementId}`;
  const {
    data: statement,
    error,
    isLoading,
    mutate,
  } = useSWR<Statement>(allowed ? path : null, ONE_DOCUMENT);
  // For where the statement goes when it is issued.
  const owner = useSWR<Owner>(statement ? `/owners/${statement.ownerId}` : null, ONE_DOCUMENT);
  const { properties } = useProperties();
  useLive(/^owner/, () => void mutate());

  const again = useAction(async () => {
    if (!statement) return;
    const fresh = await api<Statement>(`/owner-contracts/${statement.contractId}/statements`, {
      body: { month: monthKey(statement.periodStart) },
    });
    await mutate(fresh, { revalidate: false });
    toast.success('Statement prepared again', 'It now counts the stays and costs as they are.');
  });
  const [downloading, setDownloading] = useState(false);

  if (!allowed) return <NoAccess />;
  if (error && !statement) {
    return (
      <NotHere
        error={error}
        onRetry={() => void mutate()}
        title="This statement is not here"
        missing="There is no statement at this address. A draft that has been deleted no longer has a page."
        refused="This statement is for a property whose accounts you do not keep. Ask an organisation admin if you need it."
        back={{ href: LIST, label: 'Back to statements' }}
      />
    );
  }
  if (isLoading || !statement) return <PageLoading label="Loading the statement" />;

  const { status } = statement;
  const month = statementMonth(statement);
  // A statement is issued once its month has ended where the property is.
  const timezone = properties.find((p) => p.id === statement.propertyId)?.timezone;
  const today = timezone ? todayIn(timezone) : localToday();
  const monthOver = today >= statement.periodEnd;
  // The worker drafts the month just ended for any contract that has no statement for it.
  const lastMonth = monthKey(statement.periodStart) === shiftMonth(monthKey(today), -1);
  const recipient = owner.data?.email ?? null;

  // Back returns to the list as it was left, filters and all, when the statement was opened from it.
  const back = () => (window.history.length > 1 ? router.back() : router.push(LIST));
  const print = () => window.print();
  const save = async () => {
    setDownloading(true);
    try {
      await downloadStatement(path, statement);
    } catch (err) {
      toast.error(`Could not download the statement. ${errorMessage(err)}`);
    } finally {
      setDownloading(false);
    }
  };

  const issue = async () => {
    const issued = await api<IssuedStatement>(`${path}/issue`, { method: 'POST' });
    const { ownerEmailed, ...fresh } = issued;
    await mutate(fresh, { revalidate: false });
    void owner.mutate();
    setOpen(null);
    if (ownerEmailed) {
      setNotEmailed(null);
      toast.success(`Statement ${fresh.number} issued`, `Emailed to ${recipient ?? 'the owner'}.`);
    } else {
      setNotEmailed(
        recipient
          ? `The statement could not be emailed to ${recipient}: no mail server is set up, or it did not take the message. Print it or download it and send it yourself.`
          : `${fresh.ownerName} has no email address, so the statement was not emailed. Print it or download it and send it yourself.`,
      );
      toast.success(`Statement ${fresh.number} issued`, 'It was not emailed to the owner.');
    }
  };

  const remove = async () => {
    await api(path, { method: 'DELETE' });
    toast.success(`Draft for ${month} deleted`);
    router.replace(LIST);
  };

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mx-auto mb-4 flex w-full max-w-[210mm] flex-col gap-3 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button icon={<ArrowLeft className="size-4" aria-hidden />} onClick={back}>
              Back
            </Button>
            <h1 className="min-w-0 text-base font-semibold text-ink">Statement for {month}</h1>
            <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>
          </div>
          <KeepFocus label="Statement actions" className="flex flex-wrap items-center gap-2">
            {status === 'draft' && (
              <>
                <Button
                  icon={<RefreshCw className="size-4" aria-hidden />}
                  loading={again.busy}
                  onClick={() => void again.run()}
                >
                  Prepare again
                </Button>
                <Button
                  icon={<PenLine className="size-4" aria-hidden />}
                  onClick={() => setOpen('adjust')}
                >
                  Adjustments and note
                </Button>
                <Button
                  variant="primary"
                  icon={<Send className="size-4" aria-hidden />}
                  disabled={!monthOver}
                  onClick={() => setOpen('issue')}
                >
                  Issue
                </Button>
                <Menu
                  trigger={
                    <Button
                      size="icon"
                      className="h-9 w-9"
                      aria-label="More actions"
                      loading={downloading}
                    >
                      {!downloading && <MoreHorizontal className="size-4" aria-hidden />}
                    </Button>
                  }
                >
                  <MenuItem icon={<Printer />} onSelect={print}>
                    Print the draft
                  </MenuItem>
                  <MenuItem icon={<Download />} onSelect={() => void save()}>
                    Download as a spreadsheet
                  </MenuItem>
                  <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => setOpen('delete')}>
                    Delete the draft
                  </MenuItem>
                </Menu>
              </>
            )}
            {status !== 'draft' && (
              <>
                <Button
                  icon={<Download className="size-4" aria-hidden />}
                  loading={downloading}
                  onClick={() => void save()}
                >
                  Download
                </Button>
                <Button
                  variant={status === 'paid' ? 'primary' : 'secondary'}
                  icon={<Printer className="size-4" aria-hidden />}
                  onClick={print}
                >
                  Print
                </Button>
              </>
            )}
            {status === 'issued' && (
              <Button
                variant="primary"
                icon={<BadgeCheck className="size-4" aria-hidden />}
                onClick={() => setOpen('paid')}
              >
                Mark as paid
              </Button>
            )}
          </KeepFocus>
        </div>

        <p className="text-sm text-ink-soft">
          For{' '}
          <Link
            href={`/owners/${statement.ownerId}`}
            className="font-medium text-brand-700 hover:underline"
          >
            {statement.ownerName}
          </Link>
          , {villaName(statement)}.
          {status === 'draft' &&
            ` Figures as of ${formatDateTime(statement.updatedAt)}. Prepare it again to count stays and costs changed since then.`}
        </p>

        {again.error && <Notice tone="danger">Could not prepare it again. {again.error}</Notice>}
        {status === 'draft' && !monthOver && (
          <Notice tone="info">
            {month} is not over yet, so this draft shows the month so far: the stays whose guests
            have arrived, counted up to the day they are booked to leave. It can be issued from{' '}
            {formatDate(statement.periodEnd)}.
          </Notice>
        )}
        {notEmailed && status !== 'draft' && <Notice tone="warning">{notEmailed}</Notice>}
      </div>

      <StatementDocument statement={statement} />

      {open === 'adjust' && (
        <AdjustmentsDialog
          statement={statement}
          onClose={() => setOpen(null)}
          onSaved={(saved) => void mutate(saved, { revalidate: false })}
        />
      )}
      {open === 'paid' && (
        <PaidDialog
          statement={statement}
          onClose={() => setOpen(null)}
          onSaved={(saved) => void mutate(saved, { revalidate: false })}
        />
      )}
      {open === 'issue' && (
        <ConfirmDialog
          title={`Issue the statement for ${month}?`}
          confirmLabel="Issue statement"
          tone="primary"
          onClose={() => setOpen(null)}
          onConfirm={issue}
        >
          <p>
            It gets its number, and from then on neither it nor the costs on it can be changed or
            deleted. A later correction goes on the next statement as an adjustment.
          </p>
          <p>
            {owner.error && !owner.data
              ? `Whether ${statement.ownerName} has an email address could not be checked (${errorMessage(owner.error)}). If they have one, the statement is emailed to it.`
              : !owner.data
                ? 'Checking where it will be sent…'
                : recipient
                  ? `It is emailed to ${statement.ownerName} at ${recipient}${
                      owner.data.user
                        ? ', and they can see it in the owner portal.'
                        : '. They have no access to the owner portal, so the email is how they receive it.'
                    }`
                  : `${statement.ownerName} has no email address, so nothing is sent${
                      owner.data.user
                        ? '; they can see it in the owner portal.'
                        : '. Add one on their page first if they should receive it.'
                    }`}
          </p>
          <p>
            The figures are worked out one last time as it is issued. As they stand,{' '}
            <span className="tabular font-medium text-ink">
              {money(statement.payout, statement.currency)}
            </span>{' '}
            is payable to the owner.
          </p>
        </ConfirmDialog>
      )}
      {open === 'delete' && (
        <ConfirmDialog
          title={`Delete the draft for ${month}?`}
          confirmLabel="Delete draft"
          onClose={() => setOpen(null)}
          onConfirm={remove}
        >
          <p>
            The draft is discarded together with its adjustments and its note. The costs stay with
            the contract, and the statement can be prepared again at any time.
          </p>
          {lastMonth && (
            <p>
              As this is the month just ended, a new draft will be prepared automatically within a
              day.
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
