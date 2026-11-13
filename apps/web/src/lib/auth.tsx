'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { can, canAcrossOrganisation, propertyScope, type Permission } from '@pms/domain/shared';
import { PageLoading, ErrorState } from '@/components/ui/misc';
import { ApiError } from './api';
import type { Me } from './types';

interface AuthContextValue {
  me: Me;
  /** Whether the signed-in user may do this, on a given property or on any. */
  can(permission: Permission, propertyId?: string | null): boolean;
  canOrgWide(permission: Permission): boolean;
  scope(permission: Permission): 'all' | string[];
  refresh(): Promise<unknown>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthGate');
  return value;
}

/**
 * Renders its children only for a fully signed-in user. Anyone else is sent
 * to the sign-in page, which also handles the second-factor step. This is a
 * convenience for navigation: the API enforces access on every request.
 *
 * `enrollment` is the forced two-step set-up; it calls `done` when the user has
 * finished it.
 */
export function AuthGate({
  children,
  enrollment,
}: {
  children: ReactNode;
  enrollment: (done: () => void) => ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    data: me,
    error,
    isLoading,
    isValidating,
    mutate,
  } = useSWR<Me>('/auth/me', { revalidateOnFocus: true });

  // A "signed out" answer may be left over from before signing in. Act on it
  // only once the check that is in flight has come back.
  const refused = error instanceof ApiError && error.status === 401;
  const unauthenticated = refused && !isValidating;
  const needsSecondFactor = me?.mfaPending === true;

  // The forced set-up stays on screen until the user finishes it. Confirming the code clears
  // `mustEnrollTwoFactor` on the next session refresh (any window focus), and that must not
  // take away the recovery codes, which are shown only once.
  const [enrolling, setEnrolling] = useState(false);
  if (me?.mustEnrollTwoFactor && !enrolling) setEnrolling(true);
  const finishEnrollment = async () => {
    const fresh = await mutate();
    if (fresh && !fresh.mustEnrollTwoFactor) setEnrolling(false);
  };

  useEffect(() => {
    if (unauthenticated || needsSecondFactor) {
      const returnTo =
        pathname && pathname !== '/' ? `?returnTo=${encodeURIComponent(pathname)}` : '';
      router.replace(`/login${returnTo}`);
    }
  }, [unauthenticated, needsSecondFactor, pathname, router]);

  const value = useMemo<AuthContextValue | null>(() => {
    if (!me) return null;
    return {
      me,
      can: (permission, propertyId) => can(me.grants, permission, propertyId),
      canOrgWide: (permission) => canAcrossOrganisation(me.grants, permission),
      scope: (permission) => propertyScope(me.grants, permission),
      refresh: () => mutate(),
    };
  }, [me, mutate]);

  if (error && !refused) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <ErrorState error={error} onRetry={() => void mutate()} />
      </div>
    );
  }
  if (isLoading || !value || refused || needsSecondFactor) {
    return (
      <div className="h-dvh">
        <PageLoading />
      </div>
    );
  }
  return (
    <AuthContext.Provider value={value}>
      {enrolling ? enrollment(() => void finishEnrollment()) : children}
    </AuthContext.Provider>
  );
}
