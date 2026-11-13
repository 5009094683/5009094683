'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import useSWR from 'swr';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Notice, PageLoading } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

export default function SetupPage() {
  const router = useRouter();
  const { data: setup } = useSWR<{ setupComplete: boolean }>('/setup/status');
  const [form, setForm] = useState({
    orgName: '',
    adminName: '',
    adminEmail: '',
    adminPassword: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (setup?.setupComplete) router.replace('/login');
  }, [setup, router]);

  if (!setup || setup.setupComplete) return <PageLoading />;

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: e.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/setup', { body: form });
      router.replace('/settings/properties?welcome=1');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Welcome" subtitle="Create your organisation and the first administrator">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Organisation name" hint="The name of your hotel and villa group.">
          {(props) => (
            <Input {...props} value={form.orgName} onChange={set('orgName')} autoFocus required />
          )}
        </Field>
        <Field label="Your name">
          {(props) => (
            <Input
              {...props}
              value={form.adminName}
              onChange={set('adminName')}
              autoComplete="name"
              required
            />
          )}
        </Field>
        <Field label="Email">
          {(props) => (
            <Input
              {...props}
              type="email"
              value={form.adminEmail}
              onChange={set('adminEmail')}
              autoComplete="username"
              required
            />
          )}
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          {(props) => (
            <Input
              {...props}
              type="password"
              value={form.adminPassword}
              onChange={set('adminPassword')}
              autoComplete="new-password"
              minLength={10}
              required
            />
          )}
        </Field>
        <Button type="submit" variant="primary" loading={busy}>
          Create organisation
        </Button>
      </form>
    </AuthCard>
  );
}
