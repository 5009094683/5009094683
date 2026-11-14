'use client';

import type { ReactNode } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { TwoFactorEnrollment } from '@/components/auth/two-factor-enrollment';
import { Shell } from '@/components/shell/shell';
import { AuthGate } from '@/lib/auth';
import { LiveProvider } from '@/lib/live';

function ForcedEnrollment({ onDone }: { onDone: () => void }) {
  return (
    <AuthCard
      title="Set up two-step verification"
      subtitle="Your organisation requires a second step when signing in"
    >
      <TwoFactorEnrollment onDone={onDone} />
    </AuthCard>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate enrollment={(done) => <ForcedEnrollment onDone={done} />}>
      <LiveProvider>
        <Shell>{children}</Shell>
      </LiveProvider>
    </AuthGate>
  );
}
