'use client';

import { Pencil, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/settings/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/field';
import { Badge, Card, EmptyState, Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { RuleDialog } from './rule-dialog';
import type { AutomationRule, MessageTemplate } from './types';
import { TRIGGERS, ruleScope, ruleSentence, ruleWords, templateProblem } from './wording';

type Open = { kind: 'edit' | 'delete' | 'switch-on'; rule: AutomationRule } | { kind: 'new' };

/** In the order a guest meets them: on booking, before arrival, on the day, after the stay, on cancelling. */
function inOrder(rules: AutomationRule[]): AutomationRule[] {
  const moment = (rule: AutomationRule) =>
    TRIGGERS.indexOf(rule.trigger) * 1000 +
    (rule.trigger === 'pre_arrival' ? 500 - rule.offsetDays : rule.offsetDays);
  return [...rules].sort((a, b) => moment(a) - moment(b) || a.name.localeCompare(b.name));
}

/** The rule as the server takes it: saving replaces every field, so all of them are sent. */
function bodyOf(rule: AutomationRule, active: boolean) {
  return {
    name: rule.name,
    propertyId: rule.propertyId,
    trigger: rule.trigger,
    offsetDays: rule.offsetDays,
    sendHour: rule.sendHour,
    templateKey: rule.templateKey,
    channels: rule.channels,
    sources: rule.sources,
    active,
  };
}

function SwitchOnDialog({
  rule,
  templates,
  properties,
  onClose,
  onDone,
}: {
  rule: AutomationRule;
  templates: MessageTemplate[];
  properties: Property[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const problem = templateProblem(ruleWords(rule), templates);
  const switchOn = useAction(async () => {
    await api(`/messaging/automations/${rule.id}`, { method: 'PUT', body: bodyOf(rule, true) });
    toast.success(`\u201c${rule.name}\u201d switched on`);
    onDone();
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Switch on \u201c${rule.name}\u201d?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={switchOn.busy} onClick={() => void switchOn.run()}>
            Switch on
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-ink-soft">
        {switchOn.error && <Notice tone="danger">{switchOn.error}</Notice>}
        <p className="text-ink">
          {ruleSentence(ruleWords(rule), templates)} {ruleScope(ruleWords(rule), properties)}
        </p>
        {problem ? (
          <Notice tone="warning">{problem}</Notice>
        ) : (
          <p>
            Guests whose bookings are already due get this message within about a minute. After that
            it goes out automatically. Each booking gets it once.
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** The messages that are sent automatically, each said as a sentence, with a switch. */
export function RulesTab({
  rules,
  templates,
  properties,
  adding,
  onAddingDone,
  onChanged,
}: {
  rules: AutomationRule[];
  templates: MessageTemplate[];
  properties: Property[];
  /** The page's "New automatic message" button was pressed. */
  adding: boolean;
  onAddingDone: () => void;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const [opened, setOpened] = useState<Open | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const open: Open | null = adding ? { kind: 'new' } : opened;
  const close = () => {
    setOpened(null);
    onAddingDone();
  };
  const canManage = (rule: AutomationRule) =>
    rule.propertyId
      ? auth.can('property.manage', rule.propertyId)
      : auth.canOrgWide('property.manage');

  const switchOff = async (rule: AutomationRule) => {
    setBusyId(rule.id);
    try {
      await api(`/messaging/automations/${rule.id}`, { method: 'PUT', body: bodyOf(rule, false) });
      toast.success(`\u201c${rule.name}\u201d switched off`, 'Nothing more is sent by it.');
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      {rules.length === 0 ? (
        <EmptyState
          icon={<Send className="size-5" />}
          title="No automatic messages"
          description="Nothing is sent to guests automatically. An automatic message sends a template at a moment in the stay, such as two days before arrival."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {inOrder(rules).map((rule) => {
            const words = ruleWords(rule);
            const problem = templateProblem(words, templates);
            const manage = canManage(rule);
            return (
              <li key={rule.id}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="min-w-0 text-base font-semibold break-words text-ink">
                      {rule.name}
                    </h2>
                    {manage ? (
                      <div className="flex shrink-0 items-center gap-2 pt-0.5">
                        <span
                          aria-hidden
                          className={cn(
                            'text-[13px] font-medium',
                            rule.active ? 'text-success-700' : 'text-ink-faint',
                          )}
                        >
                          {rule.active ? 'On' : 'Off'}
                        </span>
                        <Switch
                          checked={rule.active}
                          disabled={busyId === rule.id}
                          label={`Send \u201c${rule.name}\u201d automatically`}
                          onChange={(next) =>
                            next ? setOpened({ kind: 'switch-on', rule }) : void switchOff(rule)
                          }
                        />
                      </div>
                    ) : (
                      <Badge tone={rule.active ? 'success' : 'neutral'}>
                        {rule.active ? 'On' : 'Off'}
                      </Badge>
                    )}
                  </div>
                  <p className={cn('mt-1.5 text-sm', rule.active ? 'text-ink' : 'text-ink-soft')}>
                    {ruleSentence(words, templates)}
                  </p>
                  <p className="mt-0.5 text-sm text-ink-soft">{ruleScope(words, properties)}</p>
                  {problem && (
                    <Notice tone="warning" className="mt-2.5">
                      {problem}
                    </Notice>
                  )}
                  {manage && (
                    <div className="mt-2 -mb-1 -ml-2 flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Pencil className="size-3.5" />}
                        aria-label={`Edit ${rule.name}`}
                        onClick={() => setOpened({ kind: 'edit', rule })}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 className="size-3.5" />}
                        aria-label={`Delete ${rule.name}`}
                        onClick={() => setOpened({ kind: 'delete', rule })}
                      >
                        Delete
                      </Button>
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {(open?.kind === 'new' || open?.kind === 'edit') && (
        <RuleDialog
          rule={open.kind === 'edit' ? open.rule : undefined}
          templates={templates}
          properties={properties}
          onClose={close}
          onSaved={onChanged}
        />
      )}
      {open?.kind === 'switch-on' && (
        <SwitchOnDialog
          rule={open.rule}
          templates={templates}
          properties={properties}
          onClose={close}
          onDone={() => {
            onChanged();
            close();
          }}
        />
      )}
      {open?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete \u201c${open.rule.name}\u201d?`}
          confirmLabel="Delete automatic message"
          onClose={close}
          onConfirm={async () => {
            await api(`/messaging/automations/${open.rule.id}`, { method: 'DELETE' });
            toast.success(`\u201c${open.rule.name}\u201d deleted`);
            onChanged();
            close();
          }}
        >
          <p>
            It stops sending, and what it has sent so far disappears from the log. This cannot be
            undone.
          </p>
          <p className="mt-2">To stop it and keep the log, switch it off instead.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
