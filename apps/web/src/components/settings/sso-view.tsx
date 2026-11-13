'use client';

import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { ROLE_LABELS } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  PageLoading,
} from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { SsoProvider } from '@/lib/types';
import { ConfirmDialog } from './confirm-dialog';
import { CopyField } from './fields';
import { LinkDialog } from './link-dialog';
import { NoAccess } from './no-access';
import { useRoles, type RoleInfo } from './roles';
import { SsoDialog } from './sso-dialog';

type Open =
  | { kind: 'add' }
  | { kind: 'edit'; provider: SsoProvider }
  | { kind: 'delete'; provider: SsoProvider }
  | { kind: 'created'; provider: SsoProvider };

function ProviderCard({
  provider,
  roles,
  onEdit,
  onDelete,
}: {
  provider: SsoProvider;
  roles: RoleInfo[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const roleLabel = provider.defaultRole
    ? (roles.find((info) => info.role === provider.defaultRole)?.label ??
      ROLE_LABELS[provider.defaultRole])
    : null;
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-2">
          <h2 className="font-semibold text-ink">{provider.name}</h2>
          <span className="font-mono text-xs text-ink-faint">{provider.slug}</span>
          {provider.enabled ? (
            <Badge tone="success">Enabled</Badge>
          ) : (
            <Badge tone="neutral">Not enabled</Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            icon={<Pencil className="size-3.5" />}
            aria-label={`Edit ${provider.name}`}
            onClick={onEdit}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="danger-ghost"
            icon={<Trash2 className="size-3.5" />}
            aria-label={`Delete ${provider.name}`}
            onClick={onDelete}
          >
            Delete
          </Button>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-[13px] text-ink-faint">Issuer</dt>
          <dd className="break-all text-ink">{provider.issuer}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-ink-faint">Allowed email domains</dt>
          <dd className="break-words text-ink">
            {provider.allowedEmailDomains.length > 0 ? (
              provider.allowedEmailDomains.join(', ')
            ) : (
              <span className="text-warning-700">None, so nobody can sign in this way</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[13px] text-ink-faint">New accounts</dt>
          <dd className="text-ink">
            {provider.autoProvision
              ? roleLabel
                ? `Created on first sign-in as ${roleLabel}, all properties`
                : 'Created on first sign-in, without a role'
              : 'Not created automatically'}
          </dd>
        </div>
      </dl>

      <CopyField
        label="Redirect URI"
        value={provider.redirectUri}
        hint="Register this address as an allowed redirect URI at the identity provider."
        className="mt-3"
      />
    </Card>
  );
}

export function SsoView() {
  const auth = useAuth();
  const toast = useToast();
  const allowed = auth.can('org.manage');
  const { data, error, isLoading, mutate } = useSWR<{ providers: SsoProvider[] }>(
    allowed ? '/sso/providers' : null,
  );
  const { roles } = useRoles(allowed);
  const [open, setOpen] = useState<Open | null>(null);

  if (!allowed) return <NoAccess />;
  const close = () => setOpen(null);

  const addButton = (
    <Button
      variant="primary"
      icon={<Plus className="size-4" />}
      onClick={() => setOpen({ kind: 'add' })}
    >
      Add provider
    </Button>
  );

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Single sign-on"
        description="Let people sign in through your identity provider, using OpenID Connect."
        actions={addButton}
      />

      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : isLoading || !data ? (
        <PageLoading />
      ) : data.providers.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="size-5" />}
          title="No single sign-on providers"
          description="Everyone signs in with an email address and a password. Add an OpenID Connect provider to let people use their work account instead."
          action={addButton}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {data.providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              roles={roles}
              onEdit={() => setOpen({ kind: 'edit', provider })}
              onDelete={() => setOpen({ kind: 'delete', provider })}
            />
          ))}
        </div>
      )}

      {(open?.kind === 'add' || open?.kind === 'edit') && (
        <SsoDialog
          provider={open.kind === 'edit' ? open.provider : undefined}
          roles={roles}
          onClose={close}
          onSaved={(provider, created) => {
            void mutate();
            if (created) setOpen({ kind: 'created', provider });
          }}
        />
      )}
      {open?.kind === 'created' && (
        <LinkDialog
          title="Register the redirect URI"
          label="Redirect URI"
          link={open.provider.redirectUri}
          onClose={close}
        >
          <p className="text-sm text-ink-soft">
            {open.provider.name} is saved. Sign-in will work once this address is registered as an
            allowed redirect URI at the identity provider.
          </p>
          {open.provider.allowedEmailDomains.length === 0 && (
            <Notice tone="warning">
              No email domains are allowed yet, so nobody can sign in with this provider.
            </Notice>
          )}
        </LinkDialog>
      )}
      {open?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${open.provider.name}`}
          confirmLabel="Delete provider"
          onClose={close}
          onConfirm={async () => {
            await api(`/sso/providers/${open.provider.id}`, { method: 'DELETE' });
            toast.success(`${open.provider.name} deleted`);
            void mutate();
            close();
          }}
        >
          <p>
            People will no longer be able to sign in with {open.provider.name}. Their accounts stay,
            and they can still sign in with a password if they have one.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
