import type { ReactNode } from 'react';
import { Card } from '@/components/ui/misc';

/** Something a program sends or receives, set apart from the words around it. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[13px] break-words text-ink">
      {children}
    </code>
  );
}

/** The short note under a list that says how the thing above is used from the other system. */
export function HowTo({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="mt-4 p-4 sm:p-5">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <div className="mt-2 flex flex-col gap-2 text-sm text-ink-soft">{children}</div>
    </Card>
  );
}
