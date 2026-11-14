'use client';

import { FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { EmptyState, ErrorState, Notice, PageLoading } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { languageName } from './labels';
import type { Conversation, MessageTemplate, TemplateList, TemplateSendResult } from './types';
import { useReturnFocus } from './use-return-focus';

export type SentTemplate = NonNullable<TemplateSendResult['sent']>;

/**
 * Picks a message template and shows it as the server filled it in for this guest. Normally
 * the text then goes into the reply box to be changed and sent like any other reply. On
 * WhatsApp more than 24 hours after the guest last wrote, only a template WhatsApp has approved
 * may be sent, exactly as it is: then the server sends it.
 */
export function TemplateDialog({
  conversation,
  approvedOnly,
  onClose,
  onUse,
  onSent,
}: {
  conversation: Conversation;
  approvedOnly: boolean;
  onClose: () => void;
  onUse: (message: { body: string; subject: string | null }) => void;
  onSent: (sent: SentTemplate) => void;
}) {
  useReturnFocus();
  const reservationId = conversation.reservationId;
  const list = useSWR<TemplateList>(`/inbox/conversations/${conversation.id}/templates`);

  const [chosenId, setChosenId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const refusal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (problems.length > 0) refusal.current?.scrollIntoView({ block: 'nearest' });
  }, [problems]);

  const all = list.data?.templates ?? [];
  // WhatsApp sends its own approved wording, one per template: the one the server picks.
  const choices = approvedOnly
    ? all.filter((template) => template.preferred && template.whatsappTemplate)
    : all;
  const chosen = choices.find((template) => template.id === chosenId) ?? choices[0] ?? null;
  /** The language of a template, where it is needed to tell one wording from another. */
  const wording = (template: MessageTemplate): string | null =>
    template.language.slice(0, 2) !== 'en' ||
    choices.filter((other) => other.key === template.key).length > 1
      ? languageName(template.language)
      : null;

  const body = chosen?.body ?? '';
  const subject = chosen?.subject ?? null;
  const missing = chosen?.unfilled ?? [];

  const use = () => {
    if (!chosen) return;
    onUse({ body, subject });
    onClose();
  };

  const send = async () => {
    if (!chosen || !reservationId) return;
    setSending(true);
    setProblems([]);
    try {
      const result = await api<TemplateSendResult>(
        `/inbox/conversations/${conversation.id}/send-template`,
        { body: { templateKey: chosen.key } },
      );
      if (!result.sent) {
        setProblems(
          result.problems.length > 0 ? result.problems : ['The template could not be sent.'],
        );
        return;
      }
      onSent(result.sent);
      onClose();
    } catch (err) {
      setProblems([errorMessage(err)]);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={approvedOnly ? 'Send an approved template' : 'Use a template'}
      description={
        approvedOnly
          ? `To ${conversation.contactName} on WhatsApp.`
          : 'The message goes into the reply box, where you can change it before sending.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {approvedOnly ? (
            <Button
              variant="primary"
              disabled={!chosen || !reservationId}
              loading={sending}
              onClick={() => void send()}
            >
              Send template
            </Button>
          ) : (
            <Button variant="primary" disabled={!chosen} onClick={use}>
              Use this message
            </Button>
          )}
        </>
      }
    >
      {/* Above everything else, and brought into view: the answer to pressing Send must not
          be somewhere the dialog has scrolled past. */}
      {problems.length > 0 && (
        <div ref={refusal} className="mb-3">
          <Notice tone="danger" title="The template was not sent">
            {problems.map((problem) => (
              <p key={problem}>{problem}</p>
            ))}
          </Notice>
        </div>
      )}
      {list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={() => void list.mutate()} />
      ) : !list.data ? (
        <PageLoading label="Loading templates" />
      ) : !chosen ? (
        <EmptyState
          icon={<FileText className="size-5" />}
          title={
            approvedOnly ? 'No template is approved by WhatsApp' : 'There are no templates yet'
          }
          description={
            approvedOnly
              ? 'A template can be sent here once the name WhatsApp approved it under has been added to it, in Settings under Guest messages.'
              : 'Templates are written in Settings, under Guest messages.'
          }
        />
      ) : (
        // Both columns keep one height and scroll inside it, so the dialog stays where it is
        // while the templates are looked through.
        <div className="grid gap-4 sm:h-[26rem] sm:grid-cols-[13rem_minmax(0,1fr)]">
          {/* On a phone the list would push the message itself off the screen. Of this and the
              list below, the one that shows takes the keyboard when the dialog opens. */}
          <div className="sm:hidden">
            <Select
              aria-label="Template"
              autoFocus
              value={chosen.id}
              onChange={(event) => {
                setChosenId(event.target.value);
                setProblems([]);
              }}
            >
              {choices.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                  {wording(template) && ` (${wording(template)})`}
                </option>
              ))}
            </Select>
          </div>
          <fieldset className="scrollbar-thin hidden min-w-0 flex-col gap-1.5 sm:-m-1 sm:flex sm:overflow-y-auto sm:p-1">
            <legend className="mb-1.5 text-[13px] font-medium text-ink-soft">Template</legend>
            {choices.map((template) => {
              const selected = template.id === chosen.id;
              return (
                <label
                  key={template.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors',
                    'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500',
                    selected ? 'border-brand-500 bg-brand-50' : 'border-line hover:bg-sunken/60',
                  )}
                >
                  <input
                    type="radio"
                    name="message-template"
                    checked={selected}
                    autoFocus={selected}
                    onChange={() => {
                      setChosenId(template.id);
                      setProblems([]);
                    }}
                    className="mt-0.5 size-4 shrink-0 accent-brand-600 outline-none"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium [overflow-wrap:anywhere] text-ink">
                      {template.name}
                    </span>
                    {wording(template) && (
                      <span className="block text-xs text-ink-faint">{wording(template)}</span>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div className="scrollbar-thin flex min-w-0 flex-col gap-2.5 sm:overflow-y-auto">
            <p className="text-[13px] font-medium [overflow-wrap:anywhere] text-ink-soft">
              As {conversation.contactName} will read it
            </p>
            <div
              aria-live="polite"
              className="rounded-lg border border-line bg-canvas px-3.5 py-3 text-sm text-ink"
            >
              {subject && (
                <p className="mb-2 border-b border-line pb-2 font-medium [overflow-wrap:anywhere]">
                  <span className="font-normal text-ink-faint">Subject: </span>
                  {subject}
                </p>
              )}
              <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">{body}</p>
            </div>
            {approvedOnly && (
              <Notice tone="info">
                {reservationId
                  ? `This is sent as the WhatsApp template "${chosen.whatsappTemplate}", with the wording WhatsApp approved. It cannot be changed here.`
                  : 'A template is sent about a booking, and this conversation is not linked to one, so it cannot be sent from here.'}
              </Notice>
            )}
            {!approvedOnly && missing.length > 0 && (
              <Notice
                tone="warning"
                title={
                  reservationId
                    ? 'Some details could not be filled in'
                    : 'This conversation is not linked to a booking'
                }
              >
                <p>There is nothing to put in for:</p>
                <ul className="my-1 list-disc pl-5">
                  {missing.map((name) => (
                    <li key={name}>{list.data?.variables[name] ?? name}</li>
                  ))}
                </ul>
                <p>Those places are left empty. Check the message before you send it.</p>
              </Notice>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
