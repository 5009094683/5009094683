'use client';

import { useId, useState, type FormEvent } from 'react';
import { useFirstProblem } from '@/components/engagement/first-problem';
import { IntoView } from '@/components/engagement/into-view';
import { SwitchField } from '@/components/settings/fields';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Segmented, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { placeholdersIn } from './render';
import type {
  AutomationRule,
  AutomationTrigger,
  BookingSource,
  MessageChannel,
  MessageTemplate,
} from './types';
import {
  CHANNELS,
  CHANNEL_LABELS,
  SOURCES,
  TRIGGERS,
  TRIGGER_LABELS,
  TRIGGER_TIMING,
  hourText,
  mainVersion,
  ruleScope,
  ruleSentence,
  sourceLabel,
  templateProblem,
  timingNote,
  type RuleWords,
} from './wording';

interface Values {
  name: string;
  trigger: AutomationTrigger;
  offsetDays: string;
  sendHour: number;
  templateKey: string;
  channels: MessageChannel[];
  /** Empty: all properties. */
  propertyId: string;
  someSources: boolean;
  sources: BookingSource[];
  active: boolean;
}

type Errors = Partial<Record<'name' | 'days' | 'template' | 'sources', string>>;

const DEFAULT_DAYS: Partial<Record<AutomationTrigger, string>> = {
  pre_arrival: '2',
  post_stay: '1',
};
const DEFAULT_HOUR: Partial<Record<AutomationTrigger, number>> = {
  pre_arrival: 10,
  check_in_day: 8,
  post_stay: 11,
};
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const CHANNEL_STEPS = ['First', 'If that cannot reach the guest', 'And failing that'];

/** A template written for payment requests has an amount and a link that only a request can fill in. */
function forPaymentRequests(template: MessageTemplate | undefined): boolean {
  if (!template) return false;
  const names = placeholdersIn(template.subject, template.body);
  return names.includes('amount') || names.includes('pay_link');
}

function daysOf(values: Values): number | null {
  if (!TRIGGER_TIMING[values.trigger].days) return 0;
  return /^\d{1,3}$/.test(values.offsetDays.trim()) ? Number(values.offsetDays) : null;
}

/** What is wrong with the form. The server applies the same rules and has the last word. */
function check(values: Values, templates: MessageTemplate[]): Errors {
  const errors: Errors = {};
  if (!values.name.trim()) errors.name = 'Give the automatic message a name.';
  const days = daysOf(values);
  if (values.trigger === 'pre_arrival' && (days === null || days < 1 || days > 365)) {
    errors.days = 'Enter a whole number of days from 1 to 365.';
  }
  if (values.trigger === 'post_stay' && (days === null || days > 365)) {
    errors.days = 'Enter a whole number of days from 0 to 365. 0 is the day of departure.';
  }
  if (!values.templateKey) errors.template = 'Choose the template to send.';
  else if (!templates.some((template) => template.key === values.templateKey)) {
    errors.template = 'This template no longer exists. Choose another one.';
  }
  if (values.someSources && values.sources.length === 0) {
    errors.sources = 'Tick at least one kind of booking, or send it for every booking.';
  }
  return errors;
}

/** Adds or changes a message that is sent automatically at a moment in the stay. */
export function RuleDialog({
  rule,
  templates,
  properties,
  onClose,
  onSaved,
}: {
  /** The rule to change. Absent: a new one. */
  rule?: AutomationRule;
  templates: MessageTemplate[];
  properties: Property[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const canAll = auth.canOrgWide('property.manage');
  const [values, setValues] = useState<Values>(() => ({
    name: rule?.name ?? '',
    trigger: rule?.trigger ?? 'pre_arrival',
    offsetDays: String(rule?.offsetDays ?? 2),
    sendHour: rule?.sendHour ?? 10,
    templateKey: rule?.templateKey ?? '',
    channels: rule?.channels.length ? rule.channels : CHANNELS,
    propertyId: rule
      ? (rule.propertyId ?? '')
      : canAll
        ? ''
        : (properties.find((p) => p.active && auth.can('property.manage', p.id))?.id ?? ''),
    someSources: Boolean(rule?.sources?.length),
    sources: rule?.sources ?? [],
    // A new one starts switched off: sending to guests begins only when someone says so.
    active: rule?.active ?? false,
  }));
  const [attempted, setAttempted] = useState(false);
  const firstProblem = useFirstProblem();
  const daysErrorId = useId();
  const channelsId = useId();
  const sourcesId = useId();

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const timing = TRIGGER_TIMING[values.trigger];
  const errors = check(values, templates);
  const shown: Errors = attempted ? errors : {};
  const options = properties.filter(
    (p) => (p.active && auth.can('property.manage', p.id)) || p.id === values.propertyId,
  );
  const keys = [...new Set(templates.map((template) => template.key))]
    .map((key) => ({ key, template: mainVersion(key, templates) }))
    .filter(({ key, template }) => key === values.templateKey || !forPaymentRequests(template))
    .sort((a, b) => (a.template?.name ?? a.key).localeCompare(b.template?.name ?? b.key));
  const templateKnown = keys.some(({ key }) => key === values.templateKey);

  const words: RuleWords = {
    trigger: values.trigger,
    offsetDays: daysOf(values) ?? 0,
    sendHour: values.sendHour,
    templateKey: values.templateKey,
    channels: values.channels,
    sources: values.someSources ? values.sources : null,
    propertyId: values.propertyId || null,
  };
  const problem = values.templateKey ? templateProblem(words, templates) : null;
  const sayable = values.templateKey !== '' && !errors.days && !errors.sources;

  const setTrigger = (trigger: AutomationTrigger) =>
    setValues((current) => {
      const before = TRIGGER_TIMING[current.trigger];
      const after = TRIGGER_TIMING[trigger];
      return {
        ...current,
        trigger,
        // A moment that counts days or waits for an hour starts from the usual ones.
        offsetDays:
          after.days && !before.days ? (DEFAULT_DAYS[trigger] ?? '1') : current.offsetDays,
        sendHour: after.hour && !before.hour ? (DEFAULT_HOUR[trigger] ?? 10) : current.sendHour,
      };
    });

  const setChannel = (index: number, channel: MessageChannel | '') => {
    const next = values.channels.slice(0, index);
    if (channel) {
      next.push(channel, ...values.channels.slice(index + 1).filter((c) => c !== channel));
    }
    set('channels', next);
  };

  const save = useAction(async () => {
    const body = {
      name: values.name.trim(),
      propertyId: values.propertyId || null,
      trigger: values.trigger,
      offsetDays: daysOf(values) ?? 0,
      sendHour: values.sendHour,
      templateKey: values.templateKey,
      channels: values.channels,
      sources: values.someSources ? values.sources : null,
      active: values.active,
    };
    if (rule) await api(`/messaging/automations/${rule.id}`, { method: 'PUT', body });
    else await api('/messaging/automations', { body });
    toast.success(
      rule ? 'Automatic message saved' : 'Automatic message added',
      values.active ? undefined : 'It is switched off: nothing is sent until you switch it on.',
    );
    onSaved();
    onClose();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (Object.keys(errors).length > 0) {
      firstProblem.show();
      return;
    }
    void save.run();
  };

  const switchingOn = values.active && !(rule?.active ?? false);
  const saveLabel = rule
    ? switchingOn
      ? 'Save and switch on'
      : 'Save changes'
    : values.active
      ? 'Add and switch on'
      : 'Add, switched off';

  return (
    <Dialog
      open
      onClose={onClose}
      title={rule ? 'Edit automatic message' : 'New automatic message'}
      description="A message that is sent automatically at a moment in the stay. Each booking gets it once."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="rule-form" variant="primary" loading={save.busy}>
            {saveLabel}
          </Button>
        </>
      }
    >
      <form
        ref={firstProblem.form}
        id="rule-form"
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-4"
      >
        {save.error && (
          <IntoView>
            <Notice tone="danger">{save.error}</Notice>
          </IntoView>
        )}
        <Field label="Name" error={shown.name} hint="For your own lists. Guests do not see it.">
          {(props) => (
            <Input
              {...props}
              value={values.name}
              maxLength={120}
              autoFocus={!rule}
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="When" className={timing.hour ? 'col-span-2' : 'col-span-2 sm:col-span-4'}>
            {(props) => (
              <Select
                {...props}
                value={values.trigger}
                onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}
              >
                {TRIGGERS.map((trigger) => (
                  <option key={trigger} value={trigger}>
                    {TRIGGER_LABELS[trigger]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {timing.days && (
            <Field label={values.trigger === 'pre_arrival' ? 'Days before' : 'Days after'}>
              {(props) => (
                <Input
                  {...props}
                  // What is wrong with it is said under the whole row: this field is too narrow for it.
                  aria-invalid={shown.days ? true : undefined}
                  aria-describedby={shown.days ? daysErrorId : undefined}
                  type="number"
                  inputMode="numeric"
                  min={values.trigger === 'pre_arrival' ? 1 : 0}
                  max={365}
                  step={1}
                  value={values.offsetDays}
                  onChange={(e) => set('offsetDays', e.target.value)}
                  className="tabular"
                />
              )}
            </Field>
          )}
          {timing.hour && (
            <Field label="From" className={timing.days ? undefined : 'col-span-2'}>
              {(props) => (
                <Select
                  {...props}
                  value={values.sendHour}
                  onChange={(e) => set('sendHour', Number(e.target.value))}
                  className="tabular"
                >
                  {HOURS.map((hour) => (
                    <option key={hour} value={hour}>
                      {hourText(hour)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {shown.days && (
            <p
              id={daysErrorId}
              role="alert"
              className="col-span-2 -mt-1 text-[13px] text-danger-600 sm:col-span-4"
            >
              {shown.days}
            </p>
          )}
          <p className="col-span-2 -mt-1 text-[13px] text-ink-faint sm:col-span-4">
            {timingNote(words)}
          </p>
        </div>

        <Field
          label="Template"
          error={shown.template}
          hint="Templates that mention a payment amount or payment link are for payment requests and are not offered here."
        >
          {(props) => (
            <Select
              {...props}
              value={values.templateKey}
              onChange={(e) => set('templateKey', e.target.value)}
            >
              {!templateKnown && (
                <option value={values.templateKey} disabled={values.templateKey === ''}>
                  {values.templateKey === ''
                    ? 'Choose a template'
                    : `${values.templateKey} (no longer exists)`}
                </option>
              )}
              {keys.map(({ key, template }) => (
                <option key={key} value={key}>
                  {template?.name ?? key}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {problem && !shown.template && <Notice tone="warning">{problem}</Notice>}

        <div role="group" aria-labelledby={channelsId} className="flex flex-col gap-2">
          <p id={channelsId} className="text-[13px] font-medium text-ink-soft">
            Send it
          </p>
          {/* One under the other, in the order they are tried. */}
          <div className="flex flex-col gap-3 sm:gap-2">
            {CHANNEL_STEPS.map((step, index) => {
              const earlier = values.channels.slice(0, index);
              if (index > earlier.length) return null;
              const choices = CHANNELS.filter((channel) => !earlier.includes(channel));
              if (choices.length === 0) return null;
              return (
                <Field
                  key={step}
                  label={step}
                  className="sm:grid sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-center sm:gap-3"
                >
                  {(props) => (
                    <Select
                      {...props}
                      value={values.channels[index] ?? ''}
                      onChange={(e) => setChannel(index, e.target.value as MessageChannel | '')}
                    >
                      {index > 0 && <option value="">Nothing else</option>}
                      {choices.map((channel) => (
                        <option key={channel} value={channel}>
                          {CHANNEL_LABELS[channel]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              );
            })}
          </div>
          <p className="text-[13px] text-ink-faint">
            Only one message goes out: by the first of these that can reach the guest. A booking
            site&apos;s message box exists only for bookings that came from that site.
          </p>
        </div>

        <Field label="At">
          {(props) => (
            <Select
              {...props}
              value={values.propertyId}
              onChange={(e) => set('propertyId', e.target.value)}
            >
              {(canAll || values.propertyId === '') && <option value="">All properties</option>}
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div role="group" aria-labelledby={sourcesId} className="flex flex-col gap-2">
          <p id={sourcesId} className="text-[13px] font-medium text-ink-soft">
            For which bookings
          </p>
          <div>
            <Segmented
              label="For which bookings"
              value={values.someSources ? 'some' : 'all'}
              onChange={(value) => set('someSources', value === 'some')}
              options={[
                { value: 'all', label: 'Every booking' },
                { value: 'some', label: 'Only some' },
              ]}
            />
          </div>
          {values.someSources && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-sunken p-3 sm:grid-cols-3">
              {SOURCES.map((source) => (
                <Checkbox
                  key={source}
                  label={sourceLabel(source)}
                  checked={values.sources.includes(source)}
                  onChange={(e) =>
                    set(
                      'sources',
                      e.target.checked
                        ? [...values.sources, source]
                        : values.sources.filter((s) => s !== source),
                    )
                  }
                />
              ))}
            </div>
          )}
          {values.someSources && (
            <p className="text-[13px] text-ink-faint">
              This is how the booking reached you. “Booking site” covers every connected booking
              site.
            </p>
          )}
          {shown.sources && (
            <p role="alert" className="text-[13px] text-danger-600">
              {shown.sources}
            </p>
          )}
        </div>

        <SwitchField
          label="Switched on"
          hint="Switched off, nothing is sent. While it is on, bookings that are already due get the message within about a minute, not only later ones."
          checked={values.active}
          onChange={(active) => set('active', active)}
          className="rounded-lg border border-line p-3"
        />

        <div className="rounded-lg bg-sunken p-3">
          <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">In words</h3>
          {sayable ? (
            <p className="mt-1 text-sm text-ink">
              {ruleSentence(words, templates)} {ruleScope(words, properties)}
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-soft">
              Fill in the form to read here what will be sent, when and to whom.
            </p>
          )}
        </div>
      </form>
    </Dialog>
  );
}
