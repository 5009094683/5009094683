'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Property, UserItem } from '@/lib/types';
import {
  GrantsEditor,
  emptyGrantRow,
  grantRows,
  grantsFromRows,
  type GrantRow,
} from './grants-editor';
import type { RoleInfo } from './roles';

/** What `POST /users` answers with. */
interface CreatedUser {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'invited';
  inviteLink?: string;
  inviteEmailed: boolean;
}

/** Adds a user, or edits one's name, status and roles. */
export function UserDialog({
  user,
  isSelf = false,
  roles,
  properties,
  onClose,
  onSaved,
  onInviteLink,
}: {
  /** The user to edit; absent when adding one. */
  user?: UserItem;
  /** The user being edited is the one signed in. */
  isSelf?: boolean;
  roles: RoleInfo[];
  properties: Property[];
  onClose: () => void;
  onSaved: () => void;
  /** Called when an invitation could not be emailed, with the link to hand over instead. */
  onInviteLink: (link: string, email: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState(user?.status ?? 'active');
  const [initialRows] = useState<GrantRow[]>(() =>
    user ? grantRows(user.grants) : [emptyGrantRow()],
  );
  const [rows, setRows] = useState(initialRows);

  const save = useAction(async () => {
    const grants = grantsFromRows(rows);
    if (user) {
      const patch = {
        ...(name.trim() !== user.name ? { name: name.trim() } : {}),
        ...(status !== user.status ? { status } : {}),
        // Sending roles rewrites them and records it in the audit trail, so only when they changed.
        ...(JSON.stringify(grants) !== JSON.stringify(grantsFromRows(initialRows))
          ? { grants }
          : {}),
      };
      if (Object.keys(patch).length > 0) {
        await api(`/users/${user.id}`, { method: 'PATCH', body: patch });
        toast.success('User saved');
        onSaved();
      }
      onClose();
      return;
    }
    const created = await api<CreatedUser>('/users', {
      body: {
        name: name.trim(),
        email: email.trim(),
        ...(password ? { password } : {}),
        grants,
      },
    });
    onSaved();
    onClose();
    if (created.status === 'active') {
      toast.success(`${created.name} added`, 'They can sign in with the password you set.');
    } else if (created.inviteEmailed) {
      toast.success('Invitation sent', `${created.email} has a link to choose a password.`);
    } else if (created.inviteLink) {
      onInviteLink(created.inviteLink, created.email);
    }
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={user ? `Edit ${user.name}` : 'Add user'}
      description={user?.email}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="user-form" variant="primary" loading={save.busy}>
            {user ? 'Save' : 'Add user'}
          </Button>
        </>
      }
    >
      <form
        id="user-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-4"
      >
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            {(props) => (
              <Input
                {...props}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                autoComplete="off"
                autoFocus
                required
              />
            )}
          </Field>
          {user ? (
            <Field
              label="Status"
              hint={
                isSelf
                  ? 'You cannot disable your own account.'
                  : user.status === 'invited'
                    ? 'Becomes active when the user accepts the invitation.'
                    : 'A disabled user is signed out and cannot sign in.'
              }
            >
              {(props) => (
                <Select
                  {...props}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  disabled={isSelf}
                >
                  {user.status === 'invited' ? (
                    <option value="invited">Invited</option>
                  ) : (
                    <option value="active">Active</option>
                  )}
                  <option value="disabled">Disabled</option>
                </Select>
              )}
            </Field>
          ) : (
            <>
              <Field label="Email">
                {(props) => (
                  <Input
                    {...props}
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="off"
                    required
                  />
                )}
              </Field>
              <Field
                label="Password"
                optional
                hint="Leave empty to send an invitation link instead, so the user chooses their own. Otherwise at least 10 characters."
                className="sm:col-span-2"
              >
                {(props) => (
                  <Input
                    {...props}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={10}
                    maxLength={200}
                    autoComplete="new-password"
                  />
                )}
              </Field>
            </>
          )}
        </div>
        <GrantsEditor rows={rows} onChange={setRows} roles={roles} properties={properties} />
      </form>
    </Dialog>
  );
}
