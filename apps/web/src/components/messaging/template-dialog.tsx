'use client';

import { Braces, Plus, X } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { todayIn } from '@pms/domain/shared';
import { useFirstProblem } from '@/components/engagement/first-problem';
import { IntoView } from '@/components/engagement/into-view';
import { SwitchField } from '@/components/settings/fields';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { placeholdersIn, renderTemplate, sampleValues, strayBrackets } from './render';
import type { MessageTemplate } from './types';
import { languageName, languageOptions, propertyText } from './wording';

interface Values {
  name: string;
  key: string;
  /** Empty: all properties. */
  propertyId: string;
  language: string;
  subject: string;
  body: string;
  whatsappTemplate: string;
  whatsappParams: string[];
  active: boolean;
}

type Errors = Partial<Record<'name' | 'key' | 'version' | 'subject' | 'body' | 'whatsapp', string>>;

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;
const MAX_WHATSAPP_VALUES = 20;

/** `late_check_out_offer` from "Late check-out offer". */
function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 50);
}

/** A detail the text asks for that does not exist. The server refuses these too. */
function unknownIn(text: string, variables: Record<string, string>): string | undefined {
  const tokens = placeholdersIn(text)
    .filter((name) => !(name in variables))
    .map((name) => `{{${name}}}`);
  if (tokens.length === 0) return undefined;
  return tokens.length === 1
    ? `There is no detail called ${tokens[0]}. Choose one with \u201cInsert a detail\u201d.`
    : `There are no details called ${tokens.join(', ')}. Choose them with \u201cInsert a detail\u201d.`;
}

/**
 * Names curly brackets that do not make a complete detail. The server takes such a text as it
 * is and sends the brackets to the guest, so the form does not let it through.
 */
function strayText(pieces: string[]): string | undefined {
  if (pieces.length === 0) return undefined;
  const quoted = pieces.map((piece) => `\u201c${piece}\u201d`);
  const named =
    quoted.length > 3
      ? `${quoted.slice(0, 3).join(', ')} and more`
      : quoted.length === 1
        ? quoted[0]
        : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
  return `Guests would read ${named} exactly as typed, because ${quoted.length === 1 ? 'it is not a complete detail' : 'they are not complete details'}.`;
}

const STRAY_FIX = 'Use \u201cInsert a detail\u201d instead, or take the curly brackets out.';

function strayIn(text: string): string | undefined {
  const said = strayText(strayBrackets(text));
  return said ? `${said} ${STRAY_FIX}` : undefined;
}

/**
 * What is wrong with the form. The server applies the same rules and has the last word, except
 * for stray curly brackets, which only the form looks for.
 */
function check(
  values: Values,
  variables: Record<string, string>,
  others: MessageTemplate[],
  properties: Property[],
): Errors {
  const errors: Errors = {};
  if (!values.name.trim()) errors.name = 'Give the template a name.';
  const key = values.key.trim();
  if (!KEY_PATTERN.test(key)) {
    errors.key = 'Use 2 to 50 lower-case letters, digits and underscores, starting with a letter.';
  } else if (!values.language) {
    errors.version = 'Choose the language this version is written in.';
  } else if (
    others.some(
      (other) =>
        other.key === key &&
        other.language === values.language &&
        (other.propertyId ?? '') === values.propertyId,
    )
  ) {
    errors.version = `There is already a version of \u201c${key}\u201d in ${languageName(values.language)} for ${propertyText(values.propertyId || null, properties)}. Choose another language or property, or change that one instead.`;
  }
  const body = values.body.trim()
    ? (unknownIn(values.body, variables) ?? strayIn(values.body))
    : 'Write the text of the message.';
  if (body) errors.body = body;
  const subject = unknownIn(values.subject, variables) ?? strayIn(values.subject);
  if (subject) errors.subject = subject;
  if (
    values.whatsappTemplate.trim() &&
    values.whatsappParams.some((name) => !(name in variables))
  ) {
    errors.whatsapp = 'Choose a detail for each numbered blank, or remove the blank.';
  }
  return errors;
}

/** A button that opens the list of details below it. Picking one puts it where the cursor was. */
function InsertDetail({
  variables,
  into,
  onInsert,
}: {
  variables: Record<string, string>;
  /** What the detail goes into, for the button's name: "the text", "the subject". */
  into: string;
  onInsert: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="-mt-1 flex flex-col gap-1.5">
      <div>
        <Button
          size="sm"
          variant="ghost"
          icon={<Braces className="size-3.5" />}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={`Insert a detail into ${into}`}
          onClick={() => setOpen(!open)}
        >
          Insert a detail
        </Button>
      </div>
      {open && (
        <ul
          id={listId}
          aria-label={`Details that can go into ${into}`}
          className="scrollbar-thin max-h-52 overflow-y-auto rounded-md border border-line bg-sunken/60 p-1"
        >
          {Object.entries(variables).map(([name, description]) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onInsert(name);
                }}
                className="flex w-full flex-wrap items-baseline justify-between gap-x-3 rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-surface focus-visible:bg-surface"
              >
                <span>{description}</span>
                <span className="font-mono text-xs text-ink-faint">{`{{${name}}}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type TextField = 'subject' | 'body';

/** Adds or changes the wording of a message, with a preview of what a guest would read. */
export function TemplateDialog({
  template,
  versionOf,
  templates,
  variables,
  properties,
  readOnly = false,
  onClose,
  onSaved,
}: {
  /** The template to change. Absent: a new one. */
  template?: MessageTemplate;
  /** For a new template: the one it is another version of (same key, other language or property). */
  versionOf?: MessageTemplate;
  /** Every template, to notice a version that already exists. */
  templates: MessageTemplate[];
  variables: Record<string, string>;
  properties: Property[];
  /** Shows the template without letting it be changed. */
  readOnly?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const source = template ?? versionOf;
  const canAll = auth.canOrgWide('property.manage');
  const [values, setValues] = useState<Values>(() => ({
    name: source?.name ?? '',
    key: source?.key ?? '',
    propertyId: template
      ? (template.propertyId ?? '')
      : versionOf?.propertyId && auth.can('property.manage', versionOf.propertyId)
        ? versionOf.propertyId
        : canAll
          ? ''
          : (properties.find((p) => p.active && auth.can('property.manage', p.id))?.id ?? ''),
    // Another version differs in language or property: which is for the person to say.
    language: template?.language ?? (versionOf ? '' : 'en'),
    subject: source?.subject ?? '',
    body: source?.body ?? '',
    whatsappTemplate: source?.whatsappTemplate ?? '',
    whatsappParams: source?.whatsappParams ?? [],
    active: template?.active ?? true,
  }));
  /** Until someone types a key, a new template takes it from its name. */
  const [keyTyped, setKeyTyped] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const firstProblem = useFirstProblem();
  const boxes = { subject: useRef<HTMLDivElement>(null), body: useRef<HTMLDivElement>(null) };
  /** Where the cursor last was in each text, so a detail goes there after the field lost focus. */
  const carets = useRef<Record<TextField, [number, number] | null>>({ subject: null, body: null });

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const keyFixed = Boolean(source);
  const options = properties.filter(
    (p) => (p.active && auth.can('property.manage', p.id)) || p.id === values.propertyId,
  );
  const errors = readOnly
    ? {}
    : check(
        values,
        variables,
        templates.filter((other) => other.id !== template?.id),
        properties,
      );
  const shown: Errors =
    attempted || readOnly
      ? errors
      : {
          // What cannot work is pointed out as soon as it is there to see. What is still empty, or
          // may only be half typed (a curly bracket), waits until saving.
          version: values.language ? errors.version : undefined,
          subject: unknownIn(values.subject, variables),
          body: unknownIn(values.body, variables),
        };
  /** Until saving has pointed at them, brackets a guest would read are named under the preview. */
  const stray = attempted ? [] : strayBrackets(values.subject, values.body);

  const sampleProperty =
    properties.find((p) => p.id === values.propertyId) ??
    properties.find((p) => p.active) ??
    properties[0];
  const samples = sampleValues(
    variables,
    sampleProperty,
    todayIn(sampleProperty?.timezone ?? 'Asia/Kolkata'),
  );
  const leftOut = placeholdersIn(values.subject, values.body).filter(
    (name) => name in variables && samples[name] === '',
  );
  const subjectPreview = renderTemplate(values.subject, samples);
  const bodyPreview = renderTemplate(values.body, samples);

  const control = (field: TextField) =>
    boxes[field].current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea',
    ) ?? null;

  const rememberCaret = (field: TextField) => () => {
    const element = control(field);
    if (element) carets.current[field] = [element.selectionStart ?? 0, element.selectionEnd ?? 0];
  };

  const insert = (field: TextField, name: string) => {
    const text = values[field];
    const [start, end] = carets.current[field] ?? [text.length, text.length];
    const token = `{{${name}}}`;
    set(field, text.slice(0, start) + token + text.slice(end));
    const position = start + token.length;
    carets.current[field] = [position, position];
    // Once the new text is on screen, typing carries on right after what was inserted.
    window.requestAnimationFrame(() => {
      const element = control(field);
      element?.focus();
      element?.setSelectionRange(position, position);
    });
  };

  const save = useAction(async () => {
    const whatsappTemplate = values.whatsappTemplate.trim();
    const body = {
      key: values.key.trim(),
      name: values.name.trim(),
      propertyId: values.propertyId || null,
      language: values.language,
      subject: values.subject.trim() || null,
      body: values.body,
      whatsappTemplate: whatsappTemplate || null,
      whatsappParams: whatsappTemplate ? values.whatsappParams : [],
      active: values.active,
    };
    if (template) {
      await api(`/messaging/templates/${template.id}`, { method: 'PUT', body });
    } else {
      await api('/messaging/templates', { body });
    }
    toast.success(template ? 'Template saved' : 'Template added');
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

  const title = readOnly
    ? (template?.name ?? 'Template')
    : template
      ? 'Edit template'
      : versionOf
        ? `Another version of \u201c${versionOf.name}\u201d`
        : 'New template';
  const description = readOnly
    ? 'What guests are sent. Only someone who manages the property can change it.'
    : versionOf
      ? 'The same message in another language, or worded differently for one property.'
      : "The wording of a message to guests. Details such as the guest's name are filled in for each booking.";

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={title}
      description={description}
      footer={
        readOnly ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" form="template-form" variant="primary" loading={save.busy}>
              {template ? 'Save template' : 'Add template'}
            </Button>
          </>
        )
      }
    >
      <form
        ref={firstProblem.form}
        id="template-form"
        onSubmit={submit}
        noValidate
        className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2"
      >
        <div className="flex min-w-0 flex-col gap-3">
          {save.error && (
            <IntoView>
              <Notice tone="danger">{save.error}</Notice>
            </IntoView>
          )}
          <Field label="Name" error={shown.name}>
            {(props) => (
              <Input
                {...props}
                value={values.name}
                maxLength={120}
                disabled={readOnly}
                autoFocus={!source}
                onChange={(e) => {
                  const name = e.target.value;
                  setValues((current) => ({
                    ...current,
                    name,
                    key: keyFixed || keyTyped ? current.key : keyFromName(name),
                  }));
                }}
              />
            )}
          </Field>
          <Field
            label="Key"
            error={shown.key}
            hint={
              keyFixed
                ? 'Automatic messages find the template by its key, so it stays as it is.'
                : 'A short name that automatic messages find the template by. Versions of one message in other languages share it.'
            }
          >
            {(props) => (
              <Input
                {...props}
                value={values.key}
                maxLength={50}
                disabled={readOnly || keyFixed}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-[13px]"
                onChange={(e) => {
                  setKeyTyped(true);
                  set('key', e.target.value.toLowerCase());
                }}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="For">
              {(props) => (
                <Select
                  {...props}
                  value={values.propertyId}
                  disabled={readOnly}
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
            <Field label="Language">
              {(props) => (
                <Select
                  {...props}
                  value={values.language}
                  disabled={readOnly}
                  onChange={(e) => set('language', e.target.value)}
                >
                  {values.language === '' && (
                    <option value="" disabled>
                      Choose one
                    </option>
                  )}
                  {languageOptions(values.language).map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {shown.version ? (
            <p role="alert" className="-mt-1 text-[13px] text-danger-600">
              {shown.version}
            </p>
          ) : (
            <p className="-mt-1 text-[13px] text-ink-faint">
              A guest gets the version written for their property and in their language. English is
              used when there is none in their language.
            </p>
          )}

          <Field
            label="Subject of the email"
            optional
            error={shown.subject}
            hint="Only email has a subject. Without one it reads “Message from” and the property's name."
          >
            {(props) => (
              <div ref={boxes.subject}>
                <Input
                  {...props}
                  value={values.subject}
                  maxLength={300}
                  disabled={readOnly}
                  onChange={(e) => set('subject', e.target.value)}
                  onSelect={rememberCaret('subject')}
                  onBlur={rememberCaret('subject')}
                />
              </div>
            )}
          </Field>
          {!readOnly && (
            <InsertDetail
              variables={variables}
              into="the subject"
              onInsert={(name) => insert('subject', name)}
            />
          )}

          <Field label="Text" error={shown.body}>
            {(props) => (
              <div ref={boxes.body}>
                <Textarea
                  {...props}
                  value={values.body}
                  rows={11}
                  maxLength={10_000}
                  disabled={readOnly}
                  className="block"
                  onChange={(e) => set('body', e.target.value)}
                  onSelect={rememberCaret('body')}
                  onBlur={rememberCaret('body')}
                />
              </div>
            )}
          </Field>
          {!readOnly && (
            <InsertDetail
              variables={variables}
              into="the text"
              onInsert={(name) => insert('body', name)}
            />
          )}

          <Field
            label="Approved WhatsApp template"
            optional
            hint="Its name in WhatsApp Business Manager. WhatsApp only lets a business start a conversation with wording it has approved: without this, the template reaches a guest on WhatsApp only within 24 hours of their last message."
          >
            {(props) => (
              <Input
                {...props}
                value={values.whatsappTemplate}
                maxLength={120}
                disabled={readOnly}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set('whatsappTemplate', e.target.value)}
              />
            )}
          </Field>
          {values.whatsappTemplate.trim() && (
            <div
              role="group"
              aria-label="Values for the approved WhatsApp template"
              className="flex flex-col gap-2 rounded-lg bg-sunken p-3"
            >
              <p className="text-[13px] text-ink-soft">
                The approved wording has numbered blanks. Say which detail goes into each, in order.
              </p>
              {values.whatsappParams.map((name, index) => (
                // Blanks are told apart by their place alone.
                <div key={index} className="flex items-center gap-2">
                  <span className="w-10 shrink-0 font-mono text-[13px] text-ink-soft">
                    {`{{${index + 1}}}`}
                  </span>
                  <Select
                    aria-label={`Detail for blank ${index + 1}`}
                    value={name}
                    disabled={readOnly}
                    onChange={(e) =>
                      set(
                        'whatsappParams',
                        values.whatsappParams.map((p, i) => (i === index ? e.target.value : p)),
                      )
                    }
                  >
                    {!(name in variables) && <option value={name}>Choose a detail</option>}
                    {Object.entries(variables).map(([variable, text]) => (
                      <option key={variable} value={variable}>
                        {text}
                      </option>
                    ))}
                  </Select>
                  {!readOnly && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove blank ${index + 1}`}
                      onClick={() =>
                        set(
                          'whatsappParams',
                          values.whatsappParams.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
              {shown.whatsapp && (
                <p role="alert" className="text-[13px] text-danger-600">
                  {shown.whatsapp}
                </p>
              )}
              {!readOnly && values.whatsappParams.length < MAX_WHATSAPP_VALUES && (
                <div>
                  <Button
                    size="sm"
                    icon={<Plus className="size-3.5" />}
                    onClick={() => set('whatsappParams', [...values.whatsappParams, ''])}
                  >
                    Add a blank
                  </Button>
                </div>
              )}
            </div>
          )}

          {!readOnly && template && (
            <SwitchField
              label="In use"
              hint="Switched off, this version is never sent."
              checked={values.active}
              onChange={(active) => set('active', active)}
              className="rounded-lg border border-line p-3"
            />
          )}
        </div>

        {/* Beside the form the preview stays in sight while the text is typed further down. */}
        <div className="scrollbar-thin flex min-w-0 flex-col gap-2 md:sticky md:top-0 md:max-h-[calc(100dvh-13rem)] md:self-start md:overflow-y-auto">
          <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Preview</h3>
          <p className="text-[13px] text-ink-soft">
            With an invented booking{sampleProperty ? ` at ${sampleProperty.name}` : ''}. Each guest
            gets the details of their own.
          </p>
          <div
            role="group"
            aria-label="Preview of the message"
            className="rounded-lg border border-line bg-sunken/60 text-sm text-ink"
          >
            {subjectPreview && (
              <p className="border-b border-line px-3 py-2 font-medium break-words">
                <span className="font-normal text-ink-faint">Subject: </span>
                {subjectPreview}
              </p>
            )}
            <p className="px-3 py-2.5 break-words whitespace-pre-wrap">
              {bodyPreview || <span className="text-ink-faint">The text will appear here.</span>}
            </p>
          </div>
          {stray.length > 0 && (
            <Notice tone="warning">
              {strayText(stray)}
              {readOnly ? '' : ` ${STRAY_FIX}`}
            </Notice>
          )}
          {leftOut.length > 0 && (
            <p className="text-[13px] text-ink-soft">
              Left out, because {sampleProperty?.name ?? 'the property'} has nothing filled in for
              it: {leftOut.map((name) => variables[name]?.toLowerCase()).join('; ')}.
            </p>
          )}
          {values.whatsappTemplate.trim() && (
            <div className="rounded-lg border border-line p-3 text-[13px] text-ink-soft">
              <p>
                On WhatsApp the guest does not receive the text above but the wording WhatsApp
                approved as{' '}
                <span className="font-mono break-all text-ink">
                  {values.whatsappTemplate.trim()}
                </span>
                {values.whatsappParams.length > 0 ? ', with these values in its blanks:' : '.'}
              </p>
              {values.whatsappParams.length > 0 && (
                <ol className="mt-1 list-decimal pl-5 text-ink">
                  {values.whatsappParams.map((name, index) => (
                    <li key={index} className="break-words">
                      {samples[name] || <span className="text-ink-faint">nothing</span>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      </form>
    </Dialog>
  );
}
