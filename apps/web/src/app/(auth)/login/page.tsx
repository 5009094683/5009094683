'use client';

import { KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import useSWR from 'swr';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Notice, PageLoading } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import type { Me } from '@/lib/types';

type Step = 'credentials' | 'second-factor' | 'forgot' | 'forgot-sent';

function safeReturnTo(value: string | null): string {
  // Only paths on this site; anything else could send the user to another site after sign-in.
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/home';
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));

  const [step, setStep] = useState<Step>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(params.get('error'));
  const [busy, setBusy] = useState(false);

  const { data: setup } = useSWR<{ setupComplete: boolean }>('/setup/status');
  const { data: providers } = useSWR<{ providers: { slug: string; name: string }[] }>(
    '/auth/providers',
  );
  const { data: me, mutate: refreshMe } = useSWR<Me>('/auth/me', { shouldRetryOnError: false });

  useEffect(() => {
    if (setup && !setup.setupComplete) router.replace('/setup');
  }, [setup, router]);

  // Already signed in, or half-way through (password accepted, code outstanding).
  useEffect(() => {
    if (!me) return;
    if (me.mfaPending) setStep('second-factor');
    else router.replace(returnTo);
  }, [me, router, returnTo]);

  const submit = async (event: FormEvent, action: () => Promise<void>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Signing in changes who "/auth/me" is. Refreshing it here, before leaving
  // the page, means the app never starts from the signed-out answer cached a
  // moment ago; the effect above then moves on to the right place.
  const signIn = (event: FormEvent) =>
    submit(event, async () => {
      const result = await api<{ status: 'ok' | 'mfa_required' }>('/auth/login', {
        body: { email, password },
      });
      if (result.status === 'mfa_required') setPassword('');
      await refreshMe();
    });

  const verify = (event: FormEvent) =>
    submit(event, async () => {
      await api('/auth/2fa/verify', { body: { code: code.trim() } });
      await refreshMe();
    });

  const requestReset = (event: FormEvent) =>
    submit(event, async () => {
      await api('/auth/password-reset/request', { body: { email } });
      setStep('forgot-sent');
    });

  if (!setup) return <PageLoading />;

  if (step === 'second-factor') {
    return (
      <AuthCard
        title="Two-step verification"
        subtitle="Enter the 6-digit code from your authenticator app"
      >
        <form onSubmit={verify} className="flex flex-col gap-4">
          {error && <Notice tone="danger">{error}</Notice>}
          <Field label="Verification code" hint="You can also enter one of your recovery codes.">
            {(props) => (
              <Input
                {...props}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                className="text-center text-lg tracking-[0.3em]"
              />
            )}
          </Field>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            icon={<ShieldCheck className="size-4" />}
          >
            Verify
          </Button>
          <button
            type="button"
            className="text-[13px] text-ink-soft underline-offset-2 hover:underline"
            onClick={async () => {
              await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
              setCode('');
              setError(null);
              setStep('credentials');
            }}
          >
            Sign in as someone else
          </button>
        </form>
      </AuthCard>
    );
  }

  if (step === 'forgot' || step === 'forgot-sent') {
    return (
      <AuthCard title="Reset your password" subtitle="We will email you a link to choose a new one">
        {step === 'forgot-sent' ? (
          <div className="flex flex-col gap-4">
            <Notice tone="success">
              If an account exists for {email}, a reset link is on its way. The link works once and
              expires in two hours.
            </Notice>
            <Button onClick={() => setStep('credentials')}>Back to sign in</Button>
          </div>
        ) : (
          <form onSubmit={requestReset} className="flex flex-col gap-4">
            {error && <Notice tone="danger">{error}</Notice>}
            <Field label="Email">
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  required
                />
              )}
            </Field>
            <Button type="submit" variant="primary" loading={busy}>
              Send reset link
            </Button>
            <Button variant="ghost" onClick={() => setStep('credentials')}>
              Back to sign in
            </Button>
          </form>
        )}
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in" subtitle="Property management for your hotels and villas">
      <form onSubmit={signIn} className="flex flex-col gap-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Email">
          {(props) => (
            <Input
              {...props}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          )}
        </Field>
        <Field label="Password">
          {(props) => (
            <Input
              {...props}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          )}
        </Field>
        <Button type="submit" variant="primary" loading={busy} icon={<LogIn className="size-4" />}>
          Sign in
        </Button>
        <button
          type="button"
          className="self-center text-[13px] text-ink-soft underline-offset-2 hover:underline"
          onClick={() => {
            setError(null);
            setStep('forgot');
          }}
        >
          Forgot your password?
        </button>
      </form>

      {providers && providers.providers.length > 0 && (
        <>
          <div className="my-5 flex items-center gap-3 text-xs text-ink-faint">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="flex flex-col gap-2">
            {providers.providers.map((provider) => (
              <Link
                key={provider.slug}
                href={`/api/auth/oidc/${provider.slug}/start?returnTo=${encodeURIComponent(returnTo)}`}
                prefetch={false}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink shadow-sm transition-colors hover:bg-sunken"
              >
                <KeyRound className="size-4 text-ink-faint" aria-hidden />
                Continue with {provider.name}
              </Link>
            ))}
          </div>
        </>
      )}
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <LoginForm />
    </Suspense>
  );
}
