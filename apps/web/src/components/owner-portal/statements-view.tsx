'use client';

import { ChevronRight, FileText } from 'lucide-react';
import Link from 'next/link';
import useSWR from 'swr';
import { money } from '@/components/owners/money';
import { formatDayOf, statementMonth, villaName } from '@/components/owners/words';
import { Badge, Card, EmptyState, PageLoading } from '@/components/ui/misc';
import { PortalProblem } from './portal-frame';
import type { Statement } from './types';
import { payment } from './words';

/** Every statement the owner has been sent, newest first. */
export function StatementsView() {
  const { data, error, isLoading, mutate } = useSWR<{ statements: Statement[] }>(
    '/owner/statements',
  );

  if (error && !data) return <PortalProblem error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data) return <PageLoading label="Loading your statements" />;
  const { statements } = data;
  if (statements.length === 0) {
    return (
      <EmptyState
        icon={<FileText className="size-5" />}
        title="No statements yet"
        description="After each month ends, the office works out what the villa earned and what is due to you, and sends you a statement. Each one appears here once it has been issued."
      />
    );
  }

  const severalVillas = new Set(statements.map((statement) => statement.contractId)).size > 1;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-soft">
        One statement for each month: what the villa earned, what was taken off, and what is due to
        you.
      </p>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-line">
          {statements.map((statement) => {
            const state = payment(statement);
            return (
              <li key={statement.id}>
                <Link
                  href={`/owner/statements/${statement.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-canvas sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{statementMonth(statement)}</p>
                    <p className="truncate text-[13px] text-ink-soft">
                      {[
                        severalVillas ? villaName(statement) : null,
                        statement.number,
                        statement.status === 'paid' && statement.paidAt
                          ? `paid on ${formatDayOf(statement.paidAt)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="tabular text-sm font-semibold text-ink">
                      {money(statement.payout, statement.currency)}
                    </span>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-ink-faint" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
