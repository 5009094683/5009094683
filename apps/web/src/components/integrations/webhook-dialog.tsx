'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { SwitchField } from '@/components/settings/fields';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Segmented } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { FormError } from './form-error';
import type { CreatedWebhook, WebhookEndpoint } from './types';
import { eventFamilies, eventFamily, eventMeaning, endpointHost } from './words';

const isFamily = (event: string): boolean => event.endsWith('.*');

const sameItems = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** A problem with one part of the form, brought into view when it appears. */
function Problem({ children }: { children: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, [children]);
  return (
    <p ref={ref} role="alert" className="scroll-my-4 text-[13px] text-danger-600">
      {children}
    </p>
  );
}

function EventOption({
  name,
  meaning,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  meaning: string | undefined;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Checkbox
      className="items-start [&>input]:mt-0.5 [&>input]:shrink-0"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      label={
        <span className="min-w-0">
          <span className="font-mono text-[13px] break-all text-ink">{name}</span>
          {meaning && <span className="block text-[13px] text-ink-soft">{meaning}</span>}
        </span>
      }
    />
  );
}

/** Adds a webhook, or edits where one goes and what it is told. */
export function WebhookDialog({
  endpoint,
  events: offered,
  properties,
  onClose,
  onCreated,
  onSaved,
}: {
  /** The webhook to edit; absent when adding one. */
  endpoint?: WebhookEndpoint;
  /** Every event a webhook can ask for, as the server lists them. */
  events: readonly string[];
  properties: Property[];
  onClose: () => void;
  /** Called with the new webhook and its signing secret, which must be shown at once. */
  onCreated: (created: CreatedWebhook) => void;
  onSaved: (saved: WebhookEndpoint) => void;
}) {
  const toast = useToast();
  const eventsId = useId();
  const propertiesId = useId();
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [everything, setEverything] = useState(endpoint?.events.includes('*') ?? false);
  const [chosen, setChosen] = useState<string[]>(
    () => endpoint?.events.filter((event) => event !== '*') ?? [],
  );
  const [someProperties, setSomeProperties] = useState(Boolean(endpoint?.propertyIds));
  const [propertyIds, setPropertyIds] = useState<string[]>(() => endpoint?.propertyIds ?? []);
  const [active, setActive] = useState(true);
  const [problems, setProblems] = useState<{ url?: string; events?: string; properties?: string }>(
    {},
  );

  const families = eventFamilies(offered);
  const known = new Set(families.flatMap((f) => [`${f.family}.*`, ...f.events]));
  // Asked for once and no longer offered: listed so that it is seen and can be unticked.
  const unknown = chosen.filter((event) => !known.has(event));
  // An inactive property is offered only where the webhook already has it, so it can be unticked.
  const listedProperties = properties.filter(
    (p) => p.active || endpoint?.propertyIds?.includes(p.id),
  );

  const toggleEvent = (event: string, on: boolean) => {
    setChosen((current) => (on ? [...current, event] : current.filter((e) => e !== event)));
    setProblems((current) => ({ ...current, events: undefined }));
  };

  /** What is asked for, in the server's order. A name its whole family already covers adds nothing. */
  const eventsToSend = (): string[] => {
    if (everything) return ['*'];
    const whole = new Set(chosen.filter(isFamily).map(eventFamily));
    const wanted = new Set(chosen.filter((e) => isFamily(e) || !whole.has(eventFamily(e))));
    return [...known, ...unknown].filter((event) => wanted.has(event));
  };

  const save = useAction(async () => {
    const events = eventsToSend();
    const nextPropertyIds = someProperties ? propertyIds : null;
    const found = {
      url: url.trim() === '' ? 'Enter the full address, starting with https://' : undefined,
      events: events.length === 0 ? 'Choose at least one event.' : undefined,
      properties:
        nextPropertyIds?.length === 0
          ? 'Choose at least one property, or send for all properties.'
          : undefined,
    };
    setProblems(found);
    if (found.url || found.events || found.properties) return;

    const note = description.trim() || null;
    if (!endpoint) {
      const created = await api<CreatedWebhook>('/outbound-webhooks', {
        body: {
          url: url.trim(),
          description: note,
          events,
          propertyIds: nextPropertyIds,
          active,
        },
      });
      onCreated(created);
      return;
    }
    // Only what changed: the audit trail then records exactly that.
    const patch = {
      ...(url.trim() !== endpoint.url ? { url: url.trim() } : {}),
      ...(note !== endpoint.description ? { description: note } : {}),
      ...(!sameItems(events, endpoint.events) ? { events } : {}),
      ...((nextPropertyIds === null) !== (endpoint.propertyIds === null) ||
      !sameItems(nextPropertyIds ?? [], endpoint.propertyIds ?? [])
        ? { propertyIds: nextPropertyIds }
        : {}),
    };
    if (Object.keys(patch).length > 0) {
      onSaved(
        await api<WebhookEndpoint>(`/outbound-webhooks/${endpoint.id}`, {
          method: 'PATCH',
          body: patch,
        }),
      );
      toast.success('Webhook saved');
    }
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={endpoint ? 'Edit webhook' : 'Add webhook'}
      description={
        endpoint
          ? endpointHost(endpoint.url)
          : 'Another system is told at this address when something changes here.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="webhook-form" variant="primary" loading={save.busy}>
            {endpoint ? 'Save' : 'Add webhook'}
          </Button>
        </>
      }
    >
      <form
        id="webhook-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-4"
      >
        <FormError message={save.error} />
        <Field
          label="Address"
          hint="Where the deliveries are sent: the full address, starting with https://"
          error={problems.url}
        >
          {(props) => (
            <Input
              {...props}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setProblems((current) => ({ ...current, url: undefined }));
              }}
              inputMode="url"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              maxLength={2000}
              placeholder="https://"
              className="font-mono text-[13px]"
              autoFocus={!endpoint}
              required
            />
          )}
        </Field>
        <Field
          label="What it is for"
          optional
          hint="A note for you and your colleagues, such as the name of the system that receives it."
        >
          {(props) => (
            <Input
              {...props}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
              autoComplete="off"
            />
          )}
        </Field>

        <div role="group" aria-labelledby={eventsId} className="flex flex-col gap-2">
          <p id={eventsId} className="text-[13px] font-medium text-ink-soft">
            Events to send
          </p>
          <div>
            <Segmented
              label="Events to send"
              value={everything ? 'all' : 'some'}
              onChange={(value) => {
                setEverything(value === 'all');
                setProblems((current) => ({ ...current, events: undefined }));
              }}
              options={[
                { value: 'some', label: 'Only chosen events' },
                { value: 'all', label: 'Every event' },
              ]}
            />
          </div>
          {everything ? (
            <p className="text-[13px] text-ink-faint">
              Everything in the list is sent, and any event added later. It is asked for as{' '}
              <span className="font-mono">*</span>.
            </p>
          ) : (
            <div className="flex flex-col gap-3 rounded-lg bg-sunken p-3">
              {families.map((family) => {
                const wildcard = `${family.family}.*`;
                const whole = chosen.includes(wildcard);
                return (
                  <div key={family.family} role="group" aria-label={family.label}>
                    <p className="mb-1.5 text-xs font-semibold text-ink-soft">{family.label}</p>
                    <div className="flex flex-col gap-2">
                      {(family.events.length > 1 || whole) && (
                        <EventOption
                          name={wildcard}
                          meaning={`Everything about ${family.label.toLowerCase()}, including events added later.`}
                          checked={whole}
                          onChange={(on) => toggleEvent(wildcard, on)}
                        />
                      )}
                      {family.events.map((event) => (
                        <EventOption
                          key={event}
                          name={event}
                          meaning={eventMeaning(event)}
                          checked={whole || chosen.includes(event)}
                          disabled={whole}
                          onChange={(on) => toggleEvent(event, on)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
              {unknown.length > 0 && (
                <div role="group" aria-label="No longer offered">
                  <p className="mb-1.5 text-xs font-semibold text-ink-soft">No longer offered</p>
                  <div className="flex flex-col gap-2">
                    {unknown.map((event) => (
                      <EventOption
                        key={event}
                        name={event}
                        meaning="This event no longer exists. Untick it to save."
                        checked
                        onChange={(on) => toggleEvent(event, on)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {problems.events && <Problem>{problems.events}</Problem>}
        </div>

        <div role="group" aria-labelledby={propertiesId} className="flex flex-col gap-2">
          <p id={propertiesId} className="text-[13px] font-medium text-ink-soft">
            Properties
          </p>
          <div>
            <Segmented
              label="Properties"
              value={someProperties ? 'some' : 'all'}
              onChange={(value) => {
                setSomeProperties(value === 'some');
                setProblems((current) => ({ ...current, properties: undefined }));
              }}
              options={[
                { value: 'all', label: 'All properties' },
                { value: 'some', label: 'Only some' },
              ]}
            />
          </div>
          {someProperties && (
            <>
              <div className="grid grid-cols-1 gap-2 rounded-lg bg-sunken p-3 sm:grid-cols-2">
                {listedProperties.map((property) => (
                  <Checkbox
                    key={property.id}
                    label={
                      <span className="min-w-0 break-words">
                        {property.name}
                        {!property.active && <span className="text-ink-faint"> (inactive)</span>}
                      </span>
                    }
                    checked={propertyIds.includes(property.id)}
                    onChange={(e) => {
                      setPropertyIds((current) =>
                        e.target.checked
                          ? [...current, property.id]
                          : current.filter((id) => id !== property.id),
                      );
                      setProblems((current) => ({ ...current, properties: undefined }));
                    }}
                  />
                ))}
              </div>
              <p className="text-[13px] text-ink-faint">
                Only what happens at these properties is sent. What belongs to no single property,
                such as some alerts, goes only to a webhook for all properties.
              </p>
            </>
          )}
          {problems.properties && <Problem>{problems.properties}</Problem>}
        </div>

        {!endpoint && (
          <SwitchField
            label="Switched on"
            hint="Switch it off to set the webhook up now and start sending later."
            checked={active}
            onChange={setActive}
          />
        )}
      </form>
    </Dialog>
  );
}
