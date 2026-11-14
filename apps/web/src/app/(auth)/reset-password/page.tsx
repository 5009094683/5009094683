'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Notice, PageLoading } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const invited = params.get('invite') === '1';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password-reset/redeem', { body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const title = invited ? 'Welcome' : 'Choose a new password';
  if (!token) {
    return (
      <AuthCard title={title}>
        <Notice tone="danger">This link is incomplete. Open the link from your email again.</Notice>
      </AuthCard>
    );
  }
  if (done) {
    return (
      <AuthCard title="Password saved">
        <div className="flex flex-col gap-4">
          <Notice tone="success">Your password is set. You can sign in now.</Notice>
          <Link
            href="/login"
            className="inline-flex h-9 items-center justify-center rounded-md bg-brand-600 px-3.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Go to sign in
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={title}
      subtitle={invited ? 'Choose a password to activate your account' : undefined}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="New password" hint="At least 10 characters.">
          {(props) => (
            <Input
              {...props}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              autoFocus
              required
            />
          )}
        </Field>
        <Field label="Repeat password">
          {(props) => (
            <Input
              {...props}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          )}
        </Field>
        <Button type="submit" variant="primary" loading={busy}>
          Save password
        </Button>
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ResetForm />
    </Suspense>
  );
}
