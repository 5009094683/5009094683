'use client';

import { ArrowLeft, Download, FileQuestion, Printer } from 'lucide-react';
import Link from 'next/link';
import useSWR from 'swr';
import { downloadStatement } from '@/components/owners/download';
import { StatementDocument } from '@/components/owners/statement-document';
import { statementMonth } from '@/components/owners/words';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { PortalProblem } from './portal-frame';
import type { Statement } from './types';
import { payment } from './words';

/** What was loaded for another statement must never stand in for this one, not even for a moment. */
const ONE_DOCUMENT = { keepPreviousData: false };

/** One statement as the owner reads it: the document itself, to keep or to print. */
export function StatementView({ statementId }: { statementId: string }) {
  const toast = useToast();
  const path = `/owner/statements/${statementId}`;
  const { data: statement, error, isLoading, mutate } = useSWR<Statement>(path, ONE_DOCUMENT);

  const download = useAction(async () => {
    if (!statement) return;
    try {
      await downloadStatement(path, statement);
    } catch (err) {
      toast.error(err);
    }
  });

  const back = (
    <Link
      href="/owner/statements"
      className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-ink-soft hover:text-ink print:hidden"
    >
      <ArrowLeft className="size-4" aria-hidden />
      All statements
    </Link>
  );

  if (error && !statement) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        {error instanceof ApiError && error.status === 404 ? (
          <EmptyState
            icon={<FileQuestion className="size-5" />}
            title="This statement is not here"
            description="There is no statement of yours at this address. Every statement issued to you is listed under Statements."
          />
        ) : (
          <PortalProblem error={error} onRetry={() => void mutate()} />
        )}
      </div>
    );
  }
  if (isLoading || !statement) return <PageLoading label="Loading the statement" />;

  const state = payment(statement);
  return (
    <div className="flex flex-col gap-4">
      {back}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-ink">{statementMonth(statement)}</h2>
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<Download className="size-4" />}
            loading={download.busy}
            onClick={() => void download.run()}
          >
            Download
          </Button>
          <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>
      <StatementDocument statement={statement} />
    </div>
  );
}
