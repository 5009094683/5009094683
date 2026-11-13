'use client';

import { KeyRound } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { SwitchField } from '@/components/settings/fields';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { isLive } from './labels';
import {
  DEFAULT_FOLDER,
  DEFAULT_PORT,
  anotherMailbox,
  draftOf,
  mailboxErrors,
  readable,
  removesMailbox,
  sameMailbox,
  toInput,
  type DraftMailbox,
  type MailboxField,
} from './mailbox-draft';
import type { Connection, MailboxSettings } from './types';
import { SaveBar } from './unsaved';

const FIELDS: MailboxField[] = ['host', 'port', 'user', 'password', 'folder', 'recipient'];

/** Typed as it is, not as prose: no corrections, no capitals put in. */
const AS_TYPED = { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false } as const;

/**
 * The password of the mailbox. A stored one is never sent back, so all there is to show is that
 * there is one, with a way to put another in its place.
 */
function PasswordField({
  stored,
  value,
  error,
  disabled,
  onChange,
}: {
  stored: boolean;
  /** Null while the stored password is kept. */
  value: string | null;
  error?: string;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  // Swapping between the two takes away the button that was pressed; the keyboard goes to what
  // took its place. Not after saving, which swaps them as well.
  const asked = useRef(false);
  const replacing = value !== null;
  useEffect(() => {
    if (!asked.current) return;
    asked.current = false;
    wrapper.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, [replacing]);
  const swap = (next: string | null) => {
    asked.current = true;
    onChange(next);
  };

  if (stored && !replacing) {
    return (
      <div ref={wrapper} className="flex flex-col gap-1">
        <span className="text-[13px] font-medium text-ink-soft">Password</span>
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-sm text-ink">
            <KeyRound className="size-4 text-ink-faint" aria-hidden />A password is saved
          </span>
          <Button size="sm" disabled={disabled} onClick={() => swap('')}>
            Replace it
          </Button>
        </div>
        <p className="text-[13px] text-ink-faint">It is never shown again once it is saved.</p>
      </div>
    );
  }
  return (
    <div ref={wrapper}>
      <Field
        label={stored ? 'New password' : 'Password'}
        error={error}
        hint="Many mail services want an app password here, not the one used to sign in."
      >
        {(props) => (
          <div className="flex gap-2">
            <Input
              {...props}
              data-field="password"
              type="password"
              autoComplete="new-password"
              className="min-w-0 flex-1"
              value={value ?? ''}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
            {stored && (
              <Button disabled={disabled} onClick={() => swap(null)}>
                Keep the saved one
              </Button>
            )}
          </div>
        )}
      </Field>
    </div>
  );
}

/**
 * How the reservations mailbox is read. Changes are kept here until saved. The password is
 * write-only: it is sent when a new one is typed and otherwise left as it is.
 */
export function MailboxForm({
  connection,
  settings,
  onSaved,
}: {
  connection: Connection;
  settings: MailboxSettings;
  /** Fetches the settings and the connection again. */
  onSaved: () => Promise<unknown>;
}) {
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const saved = draftOf(settings);
  // Null while nothing has been changed, so that the fields follow what is saved.
  const [draft, setDraft] = useState<DraftMailbox | null>(null);
  // Mistakes are pointed out once saving has been tried, not while a field is still being typed.
  const [checked, setChecked] = useState(false);
  const current = draft ?? saved;
  const dirty = draft !== null && !sameMailbox(draft, saved);
  const errors = mailboxErrors(current, settings.hasPassword);
  const shown = checked ? errors : {};
  const set = (change: Partial<DraftMailbox>) => setDraft({ ...current, ...change });

  const save = useAction(async () => {
    await api<void>(`/channels/connections/${connection.id}/email/mailbox`, {
      method: 'PUT',
      body: toInput(current),
    });
    const read = isLive(connection) && readable(current, settings.hasPassword);
    await onSaved();
    setDraft(null);
    setChecked(false);
    // Saving does not start a read by itself.
    if (read) {
      void api(`/channels/connections/${connection.id}/pull`, { method: 'POST' }).catch(
        () => undefined,
      );
    }
    toast.success('Mailbox saved', read ? 'The mailbox is being read now.' : undefined);
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || save.busy) return;
    setChecked(true);
    const wrong = FIELDS.find((field) => errors[field]);
    if (wrong) {
      form.current?.querySelector<HTMLElement>(`[data-field="${wrong}"]`)?.focus();
      return;
    }
    void save.run();
  };

  return (
    <form ref={form} noValidate onSubmit={submit} className="flex flex-col gap-4">
      {!readable(saved, settings.hasPassword) && (
        <Notice tone="info">
          No mailbox is entered here.{' '}
          {settings.forwardingUrl
            ? 'Until one is, booking emails arrive only when a mail service forwards them to the address further down, or when whoever runs the server has set one mailbox for the whole installation.'
            : 'Until one is, nothing is read, unless whoever runs the server has set one mailbox for the whole installation.'}
        </Notice>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <Field
          label="Mail server"
          error={shown.host}
          hint="The name of the server that mail is read from (IMAP), such as imap.gmail.com."
        >
          {(props) => (
            <Input
              {...props}
              {...AS_TYPED}
              data-field="host"
              inputMode="url"
              maxLength={200}
              value={current.host}
              disabled={save.busy}
              onChange={(e) => set({ host: e.target.value })}
            />
          )}
        </Field>
        <Field label="Port" error={shown.port} hint={`Left empty, ${DEFAULT_PORT} is used.`}>
          {(props) => (
            <Input
              {...props}
              data-field="port"
              inputMode="numeric"
              autoComplete="off"
              maxLength={5}
              placeholder={String(DEFAULT_PORT)}
              value={current.port}
              disabled={save.busy}
              onChange={(e) => set({ port: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="User name"
          error={shown.user}
          hint="Usually the email address of the mailbox."
        >
          {(props) => (
            <Input
              {...props}
              {...AS_TYPED}
              data-field="user"
              maxLength={200}
              value={current.user}
              disabled={save.busy}
              onChange={(e) => set({ user: e.target.value })}
            />
          )}
        </Field>
        <PasswordField
          stored={settings.hasPassword}
          value={current.password}
          error={shown.password}
          disabled={save.busy}
          onChange={(password) => set({ password })}
        />
        <Field
          label="Folder"
          error={shown.folder}
          hint={`Left empty, ${DEFAULT_FOLDER} is read: the folder that new mail arrives in.`}
        >
          {(props) => (
            <Input
              {...props}
              {...AS_TYPED}
              data-field="folder"
              maxLength={200}
              placeholder={DEFAULT_FOLDER}
              value={current.folder}
              disabled={save.busy}
              onChange={(e) => set({ folder: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Only handle mail sent to"
          optional
          error={shown.recipient}
          hint="For a mailbox shared by several properties: the address this property's booking emails are sent to. Left empty, every booking email in the mailbox is handled."
        >
          {(props) => (
            <Input
              {...props}
              {...AS_TYPED}
              data-field="recipient"
              type="email"
              inputMode="email"
              value={current.recipient}
              disabled={save.busy}
              onChange={(e) => set({ recipient: e.target.value })}
            />
          )}
        </Field>
      </div>
      <SwitchField
        label="Act on changes and cancellations even when the mail server cannot confirm who sent the email"
        hint="Anyone can write an email that looks like a cancellation, so leave this off unless your mail server never gives that confirmation. While it is off, such an email is shown to staff and not acted on."
        checked={current.trustUnverifiedSenders}
        disabled={save.busy}
        onChange={(trustUnverifiedSenders) => set({ trustUnverifiedSenders })}
      />
      <p className="text-[13px] text-ink-soft">
        The mailbox is read about once a minute. Reading changes nothing in it: no email is marked
        as read, moved or deleted.{' '}
        {removesMailbox(current, saved)
          ? 'Saved like this, no mailbox is entered here any more, so nothing is read, unless whoever runs the server has set one mailbox for the whole installation.'
          : anotherMailbox(current, saved)
            ? 'This is another mailbox than the saved one, so reading starts afresh with its last 24 hours.'
            : 'The first read takes the emails of the last 24 hours.'}
      </p>
      {save.error && <Notice tone="danger">{save.error}</Notice>}
      <SaveBar
        label="Save mailbox"
        what="the mailbox settings"
        dirty={dirty}
        busy={save.busy}
        onDiscard={() => {
          setDraft(null);
          setChecked(false);
          save.clearError();
        }}
      />
    </form>
  );
}
