import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';

/**
 * A page for one owner or one statement that could not be shown. "Not found"
 * and "not allowed" are answers rather than faults: asking again gives the same
 * answer, so they are explained without a "Try again". Anything else can be
 * tried again.
 */
export function NotHere({
  error,
  onRetry,
  title,
  missing,
  refused,
  back,
}: {
  error: unknown;
  onRetry: () => void;
  title: string;
  /** Why the server may have no such record. */
  missing: ReactNode;
  /** Why the server may have refused to show it. */
  refused: ReactNode;
  back: { href: string; label: string };
}) {
  const status = error instanceof ApiError ? error.status : null;
  const link = (
    <Link href={back.href} className="text-sm font-medium text-brand-700 hover:underline">
      {back.label}
    </Link>
  );
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      {status === 404 || status === 403 ? (
        <EmptyState
          icon={<FileQuestion className="size-5" />}
          title={title}
          description={status === 404 ? missing : refused}
          action={link}
        />
      ) : (
        <>
          <ErrorState error={error} onRetry={onRetry} />
          <p className="text-center">{link}</p>
        </>
      )}
    </div>
  );
}
