'use client';

import { KeyRound, MoreHorizontal, Pencil, ShieldOff, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Menu,
  MenuItem,
  PageHeader,
  PageLoading,
} from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatRelative } from '@/lib/format';
import { useProperties } from '@/lib/hooks';
import type { UserItem } from '@/lib/types';
import { ConfirmDialog } from './confirm-dialog';
import { LinkDialog } from './link-dialog';
import { NoAccess } from './no-access';
import { grantSummaries, useRoles } from './roles';
import { RolesDialog } from './roles-dialog';
import { UserDialog } from './user-dialog';

const STATUSES: Record<string, { label: string; tone: 'success' | 'info' | 'neutral' }> = {
  active: { label: 'Active', tone: 'success' },
  invited: { label: 'Invited', tone: 'info' },
  disabled: { label: 'Disabled', tone: 'neutral' },
};

type Open =
  | { kind: 'add' }
  | { kind: 'edit'; user: UserItem }
  | { kind: 'roles' }
  | { kind: 'two-step'; user: UserItem }
  | { kind: 'invite-link'; link: string; email: string }
  | { kind: 'reset-link'; link: string; emailed: boolean; user: UserItem };

export function UsersView() {
  const auth = useAuth();
  const toast = useToast();
  const allowed = auth.can('org.manage');
  const users = useSWR<{ users: UserItem[] }>(allowed ? '/users' : null);
  const roles = useRoles(allowed);
  const properties = useProperties();
  const [open, setOpen] = useState<Open | null>(null);
  const [linkFor, setLinkFor] = useState<string | null>(null);

  if (!allowed) return <NoAccess />;

  const error = users.error ?? roles.error ?? properties.error;
  const loading = !users.data || roles.isLoading || properties.isLoading;
  const close = () => setOpen(null);
  const selfId = auth.me.user.id;

  const refresh = (user?: UserItem) => {
    void users.mutate();
    // The signed-in user's own roles and two-step state shape the whole app.
    if (user?.id === selfId) void auth.refresh();
  };

  const createResetLink = async (user: UserItem) => {
    setLinkFor(user.id);
    try {
      const result = await api<{ link: string; emailed: boolean }>(`/users/${user.id}/reset-link`, {
        method: 'POST',
      });
      setOpen({ kind: 'reset-link', user, ...result });
    } catch (err) {
      toast.error(err);
    } finally {
      setLinkFor(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Users"
        description="The people who can sign in, and what each of them may do."
        actions={
          <>
            <Button onClick={() => setOpen({ kind: 'roles' })} disabled={roles.roles.length === 0}>
              What each role can do
            </Button>
            <Button
              variant="primary"
              icon={<UserPlus className="size-4" />}
              onClick={() => setOpen({ kind: 'add' })}
              disabled={loading || Boolean(error)}
            >
              Add user
            </Button>
          </>
        }
      />

      {error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void users.mutate();
            void roles.mutate();
            void properties.mutate();
          }}
        />
      ) : loading ? (
        <PageLoading />
      ) : users.data?.users.length === 0 ? (
        <EmptyState
          icon={<Users className="size-5" />}
          title="No users yet"
          description="Add the people who should be able to sign in."
        />
      ) : (
        <Card className="overflow-hidden">
          {/* Positioned so the visually hidden column heading scrolls with the table instead of widening the page. */}
          <div className="scrollbar-thin relative overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    User
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Roles
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Two-step verification
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Last sign-in
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.data?.users.map((user) => {
                  const status = STATUSES[user.status] ?? {
                    label: user.status,
                    tone: 'neutral' as const,
                  };
                  const summaries = grantSummaries(user.grants, roles.roles, properties.properties);
                  return (
                    <tr key={user.id} className="align-top">
                      <td className="px-4 py-3">
                        <p className="font-medium text-ink">
                          {user.name}
                          {user.id === selfId && (
                            <span className="ml-1.5 font-normal text-ink-faint">(you)</span>
                          )}
                        </p>
                        <p className="text-[13px] text-ink-soft">{user.email}</p>
                      </td>
                      <td className="px-4 py-3 text-ink-soft">
                        {summaries.length === 0 ? (
                          <span className="text-ink-faint">No roles</span>
                        ) : (
                          <ul className="flex flex-col gap-0.5">
                            {summaries.map((summary) => (
                              <li key={summary}>{summary}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        {user.twoFactorEnabled ? (
                          <Badge tone="success">On</Badge>
                        ) : (
                          <span className="text-ink-faint">Off</span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-ink-soft">
                        {user.lastLoginAt ? (
                          <span title={new Date(user.lastLoginAt).toLocaleString()}>
                            {formatRelative(user.lastLoginAt)}
                          </span>
                        ) : (
                          <span className="text-ink-faint">Never</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Pencil className="size-3.5" />}
                          aria-label={`Edit ${user.name}`}
                          onClick={() => setOpen({ kind: 'edit', user })}
                        >
                          Edit
                        </Button>
                        <Menu
                          trigger={
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`More actions for ${user.name}`}
                              loading={linkFor === user.id}
                            >
                              {linkFor !== user.id && <MoreHorizontal className="size-4" />}
                            </Button>
                          }
                        >
                          <MenuItem
                            icon={<KeyRound />}
                            onSelect={() => void createResetLink(user)}
                            disabled={user.status === 'disabled'}
                          >
                            {user.status === 'invited'
                              ? 'Create new invitation link'
                              : 'Create password reset link'}
                          </MenuItem>
                          <MenuItem
                            icon={<ShieldOff />}
                            tone="danger"
                            onSelect={() => setOpen({ kind: 'two-step', user })}
                            disabled={!user.twoFactorEnabled}
                          >
                            Turn off two-step verification
                          </MenuItem>
                        </Menu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {(open?.kind === 'add' || open?.kind === 'edit') && (
        <UserDialog
          user={open.kind === 'edit' ? open.user : undefined}
          isSelf={open.kind === 'edit' && open.user.id === selfId}
          roles={roles.roles}
          properties={properties.properties}
          onClose={close}
          onSaved={() => refresh(open.kind === 'edit' ? open.user : undefined)}
          onInviteLink={(link, email) => setOpen({ kind: 'invite-link', link, email })}
        />
      )}
      {open?.kind === 'roles' && <RolesDialog roles={roles.roles} onClose={close} />}
      {open?.kind === 'invite-link' && (
        <LinkDialog
          title="Hand over the invitation"
          label="Invitation link"
          link={open.link}
          onClose={close}
        >
          <p className="text-sm text-ink-soft">
            The account for {open.email} is ready, but no mail server is configured, so the
            invitation was not emailed. Copy this link and hand it over yourself. It lets them
            choose a password, works once and expires in three days.
          </p>
        </LinkDialog>
      )}
      {open?.kind === 'reset-link' && (
        <LinkDialog
          title={open.user.status === 'invited' ? 'New invitation link' : 'Password reset link'}
          label={open.user.status === 'invited' ? 'Invitation link' : 'Reset link'}
          link={open.link}
          onClose={close}
        >
          <p className="text-sm text-ink-soft">
            {open.emailed
              ? `This link was emailed to ${open.user.email}. You can also hand it over yourself.`
              : `This link was not emailed, because no mail server is configured. Copy it and hand it to ${open.user.name} yourself.`}{' '}
            {open.user.status === 'invited'
              ? 'It lets them choose a password, works once and expires in three days.'
              : 'It lets them choose a new password, works once and expires in two hours.'}
          </p>
        </LinkDialog>
      )}
      {open?.kind === 'two-step' && (
        <ConfirmDialog
          title="Turn off two-step verification"
          confirmLabel="Turn off"
          onClose={close}
          onConfirm={async () => {
            await api(`/users/${open.user.id}/2fa/disable`, { method: 'POST' });
            toast.success(`Two-step verification turned off for ${open.user.name}`);
            refresh(open.user);
            close();
          }}
        >
          <p>
            {open.user.name} will sign in with only a password until they set up two-step
            verification again. Do this when they have lost their authenticator and their recovery
            codes.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
