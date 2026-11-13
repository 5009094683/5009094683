'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import {
  KeyGrantsEditor,
  emptyKeyGrantRow,
  keyGrantsFromRows,
  type KeyGrantRow,
} from './key-grants-editor';
import type { ApiKeysAnswer, CreatedApiKey } from './types';
import { endOfLocalDay, localToday } from './words';

/** Creates an API key. The key itself is in the answer, which the caller must show at once. */
export function ApiKeyDialog({
  roles,
  properties,
  onClose,
  onCreated,
}: {
  roles: ApiKeysAnswer['roles'];
  properties: Property[];
  onClose: () => void;
  onCreated: (created: CreatedApiKey) => void;
}) {
  const [name, setName] = useState('');
  const [rows, setRows] = useState<KeyGrantRow[]>(() => [emptyKeyGrantRow()]);
  const [expires, setExpires] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  const create = useAction(async () => {
    // The browser's own check lets a name of spaces through.
    if (name.trim() === '') {
      setNameError('Give the key a name that says what uses it.');
      return;
    }
    const created = await api<CreatedApiKey>('/api-keys', {
      body: {
        name: name.trim(),
        grants: keyGrantsFromRows(rows),
        ...(expires ? { expiresAt: endOfLocalDay(expires).toISOString() } : {}),
      },
    });
    onCreated(created);
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="New API key"
      description="A key lets another system read and change things here, within the roles you give it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="api-key-form" variant="primary" loading={create.busy}>
            Create key
          </Button>
        </>
      }
    >
      <form
        id="api-key-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create.run();
        }}
        className="flex flex-col gap-4"
      >
        {create.error && <Notice tone="danger">{create.error}</Notice>}
        <Field
          label="Name"
          hint="Say what uses the key, such as “Revenue tool”. Everything the key changes is in the audit trail under this name."
          error={nameError}
        >
          {(props) => (
            <Input
              {...props}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              maxLength={120}
              autoComplete="off"
              autoFocus
              required
            />
          )}
        </Field>
        <KeyGrantsEditor rows={rows} onChange={setRows} roles={roles} properties={properties} />
        <Field
          label="Expires on"
          optional
          hint="The key stops working at the end of this day. Leave empty for a key that works until you revoke it."
        >
          {(props) => (
            <Input
              {...props}
              type="date"
              value={expires}
              min={localToday()}
              onChange={(e) => setExpires(e.target.value)}
              className="sm:max-w-56"
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
