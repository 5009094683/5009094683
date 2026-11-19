'use client';

import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { TwoFactorEnrollment } from '@/components/auth/two-factor-enrollment';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Badge, Card, Notice, PageHeader } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import type { Me, Organization } from '@/lib/types';

function PasswordCard() {
  const auth = useAuth();
  const toast = useToast();
  const viaSso = auth.me.authMethod === 'oidc';
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm !== '' && confirm !== next;

  const change = useAction(async () => {
    await api('/auth/password', { body: { currentPassword: current, newPassword: next } });
    setCurrent('');
    setNext('');
    setConfirm('');
    toast.success('Password changed', 'Your other devices have been signed out.');
  });

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold text-ink">Password</h2>
      <p className="mt-0.5 text-sm text-ink-soft">
        Changing your password signs you out on every other device.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!mismatch) void change.run();
        }}
        className="mt-4 flex max-w-md flex-col gap-3"
      >
        {viaSso && (
          <Notice tone="info">
            You signed in through single sign-on. Your password is only used if you sign in with
            your email address and password.
          </Notice>
        )}
        {change.error && <Notice tone="danger">{change.error}</Notice>}
        {/* Lets a password manager file the new password under the right account. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={auth.me.user.email}
          readOnly
          hidden
        />
        <Field
          label="Current password"
          optional={viaSso}
          hint={viaSso ? 'Leave empty if you have never set a password.' : undefined}
        >
          {(props) => (
            <Input
              {...props}
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              maxLength={200}
              autoComplete="current-password"
              required={!viaSso}
            />
          )}
        </Field>
        <Field label="New password" hint="At least 10 characters.">
          {(props) => (
            <Input
              {...props}
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              minLength={10}
              maxLength={200}
              autoComplete="new-password"
              required
            />
          )}
        </Field>
        <Field
          label="Confirm new password"
          error={mismatch ? 'This does not match the new password.' : null}
        >
          {(props) => (
            <Input
              {...props}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              maxLength={200}
              autoComplete="new-password"
              required
            />
          )}
        </Field>
        <div>
          <Button type="submit" variant="primary" loading={change.busy} disabled={mismatch}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TurnOffForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const turnOff = useAction(async () => {
    await api('/auth/2fa/disable', { body: { password } });
    toast.success('Two-step verification turned off');
    onDone();
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void turnOff.run();
      }}
      className="mt-4 flex max-w-md flex-col gap-3"
    >
      {turnOff.error && <Notice tone="danger">{turnOff.error}</Notice>}
      <Field label="Current password" hint="Needed to confirm it is you.">
        {(props) => (
          <Input
            {...props}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={200}
            autoComplete="current-password"
            autoFocus
            required
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" loading={turnOff.busy}>
          Turn off two-step verification
        </Button>
        <Button onClick={onCancel} disabled={turnOff.busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TwoStepCard() {
  const auth = useAuth();
  const enabled = auth.me.user.twoFactorEnabled;
  const { data: organisation } = useSWR<Organization>('/org');
  // Kept apart from `enabled`: confirming the code turns two-step verification on before the
  // recovery codes have been saved, and a refresh of the session must not take them off screen.
  const [mode, setMode] = useState<'idle' | 'enrolling' | 'turning-off'>('idle');
  const [confirmed, setConfirmed] = useState(false);

  const cancelEnrolment = async () => {
    // The code may already have been confirmed, in which case the recovery codes are showing
    // and must stay. Close only on a fresh answer that two-step verification is still off.
    const me = (await auth.refresh().catch(() => undefined)) as Me | undefined;
    if (me && !me.user.twoFactorEnabled) setMode('idle');
  };

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-ink">Two-step verification</h2>
        {mode !== 'enrolling' &&
          (enabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>)}
      </div>
      <p className="mt-0.5 text-sm text-ink-soft">
        After your password, signing in also asks for a code from an authenticator app on your
        phone.
      </p>
      {auth.me.authMethod === 'oidc' && (
        <Notice tone="info" className="mt-3 max-w-2xl">
          You signed in through single sign-on, which does not ask for this code. It applies when
          you sign in with your email address and password.
        </Notice>
      )}

      {mode === 'enrolling' ? (
        <div className="mt-4 max-w-xl">
          <TwoFactorEnrollment
            onConfirmed={() => setConfirmed(true)}
            onDone={() => {
              setMode('idle');
              setConfirmed(false);
              void auth.refresh();
            }}
          />
          {!enabled && !confirmed && (
            <Button variant="ghost" className="mt-3" onClick={() => void cancelEnrolment()}>
              Cancel setup
            </Button>
          )}
        </div>
      ) : mode === 'turning-off' ? (
        <>
          {organisation?.settings.requireTwoFactor && (
            <Notice tone="warning" className="mt-3 max-w-2xl">
              Your organisation requires two-step verification. If you turn it off you will be asked
              to set it up again straight away.
            </Notice>
          )}
          <TurnOffForm
            onCancel={() => setMode('idle')}
            onDone={() => {
              setMode('idle');
              void auth.refresh();
            }}
          />
        </>
      ) : enabled ? (
        <Button className="mt-4" onClick={() => setMode('turning-off')}>
          Turn off
        </Button>
      ) : (
        <Button
          variant="primary"
          className="mt-4"
          icon={<ShieldCheck className="size-4" />}
          onClick={() => setMode('enrolling')}
        >
          Turn on
        </Button>
      )}
    </Card>
  );
}

export function SecurityView() {
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Security"
        description="How you sign in. These settings are for your own account."
      />
      <div className="flex flex-col gap-4">
        <PasswordCard />
        <TwoStepCard />
      </div>
    </div>
  );
}
