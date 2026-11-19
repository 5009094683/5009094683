'use client';

import { useId, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Card, ErrorState, Notice, PageHeader, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import type { Organization } from '@/lib/types';
import { CurrencyInput, SwitchField, TimeZoneSelect } from './fields';
import { changedFields, rebase, splitList } from './form-values';
import { NoAccess } from './no-access';

interface Values {
  name: string;
  defaultCurrency: string;
  defaultTimezone: string;
  requireTwoFactor: boolean;
  guestIdRetentionDays: string;
  guestProfileRetentionDays: string;
  alertEmails: string;
}

function valuesFrom(organisation: Organization): Values {
  const { settings } = organisation;
  return {
    name: organisation.name,
    defaultCurrency: organisation.defaultCurrency,
    defaultTimezone: organisation.defaultTimezone,
    requireTwoFactor: settings.requireTwoFactor ?? false,
    guestIdRetentionDays: String(settings.guestIdRetentionDays ?? 0),
    guestProfileRetentionDays: String(settings.guestProfileRetentionDays ?? 0),
    alertEmails: (settings.alertEmails ?? []).join(', '),
  };
}

const MAX_ALERT_EMAILS = 20;

/** What is wrong with the typed alert addresses, in words; null when they can be sent. */
function alertEmailsProblem(value: string): string | null {
  const emails = splitList(value);
  const invalid = emails.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (invalid) return `${invalid} is not an email address.`;
  if (emails.length > MAX_ALERT_EMAILS) {
    return `At most ${MAX_ALERT_EMAILS} addresses. There are ${emails.length}.`;
  }
  return null;
}

/** The PATCH that turns what `before` describes into what `values` describes. */
function patchFrom(before: Values, values: Values) {
  const fields = (v: Values) => ({
    name: v.name.trim(),
    defaultCurrency: v.defaultCurrency.trim().toUpperCase(),
    defaultTimezone: v.defaultTimezone,
  });
  const settings = (v: Values) => ({
    requireTwoFactor: v.requireTwoFactor,
    guestIdRetentionDays: Number(v.guestIdRetentionDays),
    guestProfileRetentionDays: Number(v.guestProfileRetentionDays),
    alertEmails: splitList(v.alertEmails),
  });
  const changedSettings = changedFields(settings(before), settings(values));
  return {
    ...changedFields(fields(before), fields(values)),
    ...(Object.keys(changedSettings).length > 0 ? { settings: changedSettings } : {}),
  };
}

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="grid grid-cols-1 gap-x-8 gap-y-3 border-t border-line px-4 py-5 first:border-t-0 sm:px-5 lg:grid-cols-[14rem_1fr]"
    >
      <div>
        <h2 id={headingId} className="text-sm font-semibold text-ink">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-[13px] text-ink-faint">{description}</p>}
      </div>
      <div className="flex max-w-xl flex-col gap-3">{children}</div>
    </div>
  );
}

function OrganisationForm({
  organisation,
  onSaved,
}: {
  organisation: Organization;
  onSaved: (organisation: Organization) => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const [baseline, setBaseline] = useState(organisation);
  const [values, setValues] = useState(() => valuesFrom(organisation));
  const change = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));

  // Newer settings arrived: this form's own save, or a change someone else made meanwhile.
  if (organisation !== baseline) {
    setBaseline(organisation);
    setValues(rebase(values, valuesFrom(baseline), valuesFrom(organisation)));
  }

  const patch = patchFrom(valuesFrom(baseline), values);
  const dirty = Object.keys(patch).length > 0;

  const save = useAction(async () => {
    const sent = values;
    const saved = await api<Organization>('/org', { method: 'PATCH', body: patch });
    // Shows what was stored (trimmed, upper-cased) without losing anything typed meanwhile.
    setValues((current) => rebase(current, sent, valuesFrom(saved)));
    toast.success('Organisation settings saved');
    onSaved(saved);
  });

  // Requiring two-step verification applies to this session too, as soon as it is saved.
  const locksSelfOut =
    values.requireTwoFactor &&
    !valuesFrom(baseline).requireTwoFactor &&
    auth.me.authMethod === 'password' &&
    !auth.me.user.twoFactorEnabled;

  // Checked once the field is left or the form is submitted, not on every keystroke.
  const [emailsChecked, setEmailsChecked] = useState(false);
  const emailsProblem = alertEmailsProblem(values.alertEmails);

  return (
    <Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setEmailsChecked(true);
          if (!emailsProblem) void save.run();
        }}
      >
        <Group title="Organisation" description="The name is shown at the top of the menu.">
          <Field label="Name">
            {(props) => (
              <Input
                {...props}
                value={values.name}
                onChange={(e) => change({ name: e.target.value })}
                maxLength={120}
                autoComplete="off"
                required
              />
            )}
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Default currency" hint="Three letters, such as INR.">
              {(props) => (
                <CurrencyInput
                  {...props}
                  value={values.defaultCurrency}
                  onChange={(e) => change({ defaultCurrency: e.target.value })}
                  required
                />
              )}
            </Field>
            <Field label="Default time zone">
              {(props) => (
                <TimeZoneSelect
                  {...props}
                  value={values.defaultTimezone}
                  onChange={(e) => change({ defaultTimezone: e.target.value })}
                />
              )}
            </Field>
          </div>
          <p className="-mt-1 text-[13px] text-ink-faint">
            The defaults are filled in when you add a property. Each property keeps its own currency
            and time zone.
          </p>
        </Group>

        <Group title="Sign-in">
          <SwitchField
            label="Require two-step verification for everyone"
            hint="Users who have not set it up are asked to do so the next time they sign in with a password."
            checked={values.requireTwoFactor}
            onChange={(requireTwoFactor) => change({ requireTwoFactor })}
          />
          {locksSelfOut && (
            <Notice tone="warning">
              You have not set up two-step verification yourself, so you will be asked to do it as
              soon as you save.
            </Notice>
          )}
        </Group>

        <Group title="Guest data" description="How long personal data is kept.">
          <Field
            label="Identity document retention (days)"
            hint="Identity document numbers are erased this many days after check-out. 0 keeps them until they are removed by hand."
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min={0}
                max={3650}
                step={1}
                inputMode="numeric"
                value={values.guestIdRetentionDays}
                onChange={(e) => change({ guestIdRetentionDays: e.target.value })}
                className="sm:max-w-40"
                required
              />
            )}
          </Field>
          <Field
            label="Guest profile retention (days)"
            hint="Guest profiles are anonymised this many days after the guest's last stay. 0 turns this off."
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min={0}
                max={36500}
                step={1}
                inputMode="numeric"
                value={values.guestProfileRetentionDays}
                onChange={(e) => change({ guestProfileRetentionDays: e.target.value })}
                className="sm:max-w-40"
                required
              />
            )}
          </Field>
        </Group>

        <Group title="Alerts">
          <Field
            label="Alert email addresses"
            optional
            hint={`Addresses that alerts are emailed to. Separate them with commas. Up to ${MAX_ALERT_EMAILS}.`}
            error={emailsChecked ? emailsProblem : null}
          >
            {(props) => (
              <Textarea
                {...props}
                value={values.alertEmails}
                onChange={(e) => change({ alertEmails: e.target.value })}
                onBlur={() => setEmailsChecked(true)}
                autoCapitalize="none"
                spellCheck={false}
                className="min-h-16"
              />
            )}
          </Field>
        </Group>

        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 sm:px-5">
          {save.error && (
            <Notice tone="danger" className="w-full">
              {save.error}
            </Notice>
          )}
          <Button type="submit" variant="primary" loading={save.busy} disabled={!dirty}>
            Save changes
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              disabled={save.busy}
              onClick={() => {
                setValues(valuesFrom(baseline));
                setEmailsChecked(false);
                save.clearError();
              }}
            >
              Discard changes
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

export function OrganisationView() {
  const auth = useAuth();
  const allowed = auth.can('org.manage');
  const { data, error, mutate } = useSWR<Organization>(allowed ? '/org' : null);

  if (!allowed) return <NoAccess />;

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader title="Organisation" description="Settings that apply to every property." />
      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : !data ? (
        <PageLoading />
      ) : (
        <OrganisationForm
          organisation={data}
          onSaved={(saved) => {
            void mutate(saved, { revalidate: false });
            // The menu shows the organisation's name, and requiring two-step verification
            // changes what this session may do.
            void auth.refresh();
          }}
        />
      )}
    </div>
  );
}
