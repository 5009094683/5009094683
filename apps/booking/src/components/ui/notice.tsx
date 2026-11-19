import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, { box: string; icon: typeof Info }> = {
  info: { box: 'border-info-700/20 bg-info-50 text-info-700', icon: Info },
  success: { box: 'border-success-700/20 bg-success-50 text-success-700', icon: CircleCheck },
  warning: { box: 'border-warning-700/25 bg-warning-50 text-warning-700', icon: TriangleAlert },
  danger: { box: 'border-danger-600/25 bg-danger-50 text-danger-700', icon: CircleAlert },
};

export interface NoticeProps {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  /** `alert` interrupts a screen reader (a failure), `status` waits its turn (a result). */
  role?: 'alert' | 'status';
  className?: string;
}

/** A message set apart from the page: each tone has its own icon, so colour is not the only signal. */
export function Notice({ tone = 'info', title, children, role, className }: NoticeProps) {
  const { box, icon: Icon } = TONES[tone];
  return (
    <div
      role={role}
      className={cn('flex gap-3 rounded-xl border px-4 py-3 text-[15px]', box, className)}
    >
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-ink">{children}</div> : null}
      </div>
    </div>
  );
}
