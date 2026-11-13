'use client';

import { Copy, Eye, FileText, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/settings/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, Menu, MenuItem } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import type { Property } from '@/lib/types';
import { TemplateDialog } from './template-dialog';
import type { AutomationRule, MessageTemplate } from './types';
import { languageName, mainVersion, propertyLabel, propertyText } from './wording';

type Open =
  { kind: 'edit' | 'version' | 'view' | 'delete'; template: MessageTemplate } | { kind: 'new' };

/** Versions of one message together, the organisation's own before a property's, English first. */
function inOrder(templates: MessageTemplate[], properties: Property[]): MessageTemplate[] {
  const heading = (template: MessageTemplate) =>
    (mainVersion(template.key, templates) ?? template).name;
  const place = (template: MessageTemplate) =>
    template.propertyId ? propertyText(template.propertyId, properties) : '';
  return [...templates].sort(
    (a, b) =>
      heading(a).localeCompare(heading(b)) ||
      a.key.localeCompare(b.key) ||
      place(a).localeCompare(place(b)) ||
      Number(b.language === 'en') - Number(a.language === 'en') ||
      a.language.localeCompare(b.language),
  );
}

/** The automatic messages that would send this version of a template. */
function usersOf(template: MessageTemplate, rules: AutomationRule[]): AutomationRule[] {
  return rules.filter(
    (rule) =>
      rule.templateKey === template.key &&
      (!template.propertyId || !rule.propertyId || rule.propertyId === template.propertyId),
  );
}

/** How many other versions of the same message there are: other languages, other properties. */
function versionsLeft(template: MessageTemplate, templates: MessageTemplate[]): number {
  return templates.filter((other) => other.key === template.key && other.id !== template.id).length;
}

/** A template has no channel of its own: what differs is whether WhatsApp can start a conversation with it. */
function SentBy({ template }: { template: MessageTemplate }) {
  return (
    <>
      <p>Email, booking site message box</p>
      <p className="text-[13px] text-ink-faint">
        {template.whatsappTemplate
          ? `WhatsApp, as the approved template “${template.whatsappTemplate}”`
          : 'WhatsApp only within 24 hours of the guest writing'}
      </p>
    </>
  );
}

function UsedBy({ rules }: { rules: AutomationRule[] }) {
  if (rules.length === 0) return <span className="text-ink-faint">No automatic message</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {rules.map((rule) => (
        <li key={rule.id}>
          {rule.name}
          {!rule.active && <span className="text-ink-faint"> (switched off)</span>}
        </li>
      ))}
    </ul>
  );
}

function Actions({
  template,
  canManage,
  onOpen,
}: {
  template: MessageTemplate;
  canManage: boolean;
  onOpen: (open: Open) => void;
}) {
  if (!canManage) {
    return (
      <Button
        size="sm"
        variant="ghost"
        icon={<Eye className="size-3.5" />}
        aria-label={`View ${template.name}`}
        onClick={() => onOpen({ kind: 'view', template })}
      >
        View
      </Button>
    );
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={<Pencil className="size-3.5" />}
        aria-label={`Edit ${template.name}`}
        onClick={() => onOpen({ kind: 'edit', template })}
      >
        Edit
      </Button>
      <Menu
        trigger={
          <Button size="icon" variant="ghost" aria-label={`More actions for ${template.name}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        }
      >
        <MenuItem icon={<Copy />} onSelect={() => onOpen({ kind: 'version', template })}>
          Add another version
        </MenuItem>
        <MenuItem
          icon={<Trash2 />}
          tone="danger"
          onSelect={() => onOpen({ kind: 'delete', template })}
        >
          Delete
        </MenuItem>
      </Menu>
    </>
  );
}

/** The wording of the messages guests are sent, one row for each language and property version. */
export function TemplatesTab({
  templates,
  variables,
  rules,
  properties,
  adding,
  onAddingDone,
  onChanged,
}: {
  templates: MessageTemplate[];
  variables: Record<string, string>;
  rules: AutomationRule[];
  properties: Property[];
  /** The page's "New template" button was pressed. */
  adding: boolean;
  onAddingDone: () => void;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const [opened, setOpened] = useState<Open | null>(null);
  const open: Open | null = adding ? { kind: 'new' } : opened;
  const close = () => {
    setOpened(null);
    onAddingDone();
  };
  const canManage = (template: MessageTemplate) =>
    template.propertyId
      ? auth.can('property.manage', template.propertyId)
      : auth.canOrgWide('property.manage');
  const rows = inOrder(templates, properties);
  const describe = (template: MessageTemplate) =>
    `${languageName(template.language)}, ${propertyText(template.propertyId, properties)}`;

  return (
    <>
      {rows.length === 0 ? (
        <EmptyState
          icon={<FileText className="size-5" />}
          title="No templates yet"
          description="A template is the wording of a message to guests, such as a booking confirmation."
        />
      ) : (
        // Cards until the table has the room it needs: the page's own width, not the screen's.
        <div className="@container">
          <ul className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @min-[58rem]:hidden">
            {rows.map((template) => (
              <li key={template.id}>
                <Card className="flex h-full flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{template.name}</p>
                      <p className="font-mono text-xs break-all text-ink-faint">{template.key}</p>
                    </div>
                    {!template.active && <Badge>Not in use</Badge>}
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                    <dt className="text-ink-faint">For</dt>
                    <dd className="text-ink-soft">
                      {propertyLabel(template.propertyId, properties)},{' '}
                      {languageName(template.language)}
                    </dd>
                    <dt className="text-ink-faint">Sent by</dt>
                    <dd className="text-ink-soft">
                      <SentBy template={template} />
                    </dd>
                    <dt className="text-ink-faint">Used by</dt>
                    <dd className="text-ink-soft">
                      <UsedBy rules={usersOf(template, rules)} />
                    </dd>
                    <dt className="text-ink-faint">Changed</dt>
                    <dd className="text-ink-soft">{formatDateTime(template.updatedAt)}</dd>
                  </dl>
                  <div className="mt-auto -mb-1 -ml-2 flex items-center gap-1">
                    <Actions
                      template={template}
                      canManage={canManage(template)}
                      onOpen={setOpened}
                    />
                  </div>
                </Card>
              </li>
            ))}
          </ul>

          <Card className="hidden overflow-hidden @min-[58rem]:block">
            <div className="scrollbar-thin relative overflow-x-auto">
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Template
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      For
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Sent by
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Used by
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Last changed
                    </th>
                    <th scope="col" className="px-4 py-2.5">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((template) => (
                    <tr key={template.id} className="align-top">
                      <td className="min-w-44 px-4 py-3">
                        <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                          {template.name}
                          {!template.active && <Badge>Not in use</Badge>}
                        </p>
                        <p className="font-mono text-xs break-all text-ink-faint">{template.key}</p>
                      </td>
                      <td className="min-w-32 px-4 py-3 text-ink-soft">
                        <p>{propertyLabel(template.propertyId, properties)}</p>
                        <p className="text-[13px] text-ink-faint">
                          {languageName(template.language)}
                        </p>
                      </td>
                      <td className="max-w-80 min-w-64 px-4 py-3 text-ink-soft">
                        <SentBy template={template} />
                      </td>
                      <td className="px-4 py-3 text-ink-soft">
                        <UsedBy rules={usersOf(template, rules)} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-ink-soft">
                        {formatDateTime(template.updatedAt)}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <Actions
                          template={template}
                          canManage={canManage(template)}
                          onOpen={setOpened}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {open && open.kind !== 'delete' && (
        <TemplateDialog
          template={open.kind === 'edit' || open.kind === 'view' ? open.template : undefined}
          versionOf={open.kind === 'version' ? open.template : undefined}
          templates={templates}
          variables={variables}
          properties={properties}
          readOnly={open.kind === 'view'}
          onClose={close}
          onSaved={onChanged}
        />
      )}
      {open?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete \u201c${open.template.name}\u201d?`}
          confirmLabel="Delete template"
          onClose={close}
          onConfirm={async () => {
            await api(`/messaging/templates/${open.template.id}`, { method: 'DELETE' });
            toast.success(`Template \u201c${open.template.name}\u201d deleted`);
            onChanged();
            close();
          }}
        >
          <p>
            This version ({describe(open.template)}) is removed for good. It cannot be brought back.
          </p>
          {usersOf(open.template, rules).length > 0 && (
            <p className="mt-2">
              It is used by:{' '}
              {usersOf(open.template, rules)
                .map((rule) => (rule.active ? rule.name : `${rule.name} (switched off)`))
                .join(', ')}
              .
              {versionsLeft(open.template, templates) === 0 &&
                ' It is the last version of this message: once it is gone, there is nothing left to send.'}
            </p>
          )}
          {versionsLeft(open.template, templates) > 0 && (
            <p className="mt-2">The other versions of this message stay.</p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
