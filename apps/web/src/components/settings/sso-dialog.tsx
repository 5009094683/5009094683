'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { SsoProvider } from '@/lib/types';
import { SwitchField } from './fields';
import { splitList } from './form-values';
import type { Role, RoleInfo } from './roles';

interface Values {
  slug: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  domains: string;
  autoProvision: boolean;
  defaultRole: Role | '';
  enabled: boolean;
}

/** Adds an OpenID Connect provider for single sign-on, or edits one. */
export function SsoDialog({
  provider,
  roles,
  onClose,
  onSaved,
}: {
  /** The provider to edit; absent when adding one. */
  provider?: SsoProvider;
  roles: RoleInfo[];
  onClose: () => void;
  /** Called with the saved provider, and whether it was just created. */
  onSaved: (provider: SsoProvider, created: boolean) => void;
}) {
  const toast = useToast();
  const [values, setValues] = useState<Values>({
    slug: provider?.slug ?? '',
    name: provider?.name ?? '',
    issuer: provider?.issuer ?? '',
    clientId: provider?.clientId ?? '',
    clientSecret: '',
    scopes: provider?.scopes ?? 'openid email profile',
    domains: provider?.allowedEmailDomains.join(', ') ?? '',
    autoProvision: provider?.autoProvision ?? false,
    defaultRole: provider?.defaultRole ?? '',
    enabled: provider?.enabled ?? true,
  });
  const change = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));

  const save = useAction(async () => {
    const body = {
      slug: values.slug.trim(),
      name: values.name.trim(),
      issuer: values.issuer.trim(),
      clientId: values.clientId.trim(),
      // Left out when empty: on an edit that keeps the stored secret.
      ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}),
      ...(values.scopes.trim() ? { scopes: values.scopes.trim() } : {}),
      allowedEmailDomains: [
        ...new Set(
          splitList(values.domains)
            .map((domain) => domain.replace(/^@/, '').toLowerCase())
            .filter(Boolean),
        ),
      ],
      autoProvision: values.autoProvision,
      defaultRole: values.autoProvision && values.defaultRole ? values.defaultRole : null,
      enabled: values.enabled,
    };
    const saved = provider
      ? await api<SsoProvider>(`/sso/providers/${provider.id}`, { method: 'PUT', body })
      : await api<SsoProvider>('/sso/providers', { body });
    toast.success(provider ? 'Provider saved' : `${saved.name} added`);
    // Closed first: the caller may open a follow-up dialog from `onSaved`.
    onClose();
    onSaved(saved, !provider);
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={provider ? `Edit ${provider.name}` : 'Add provider'}
      description="An OpenID Connect identity provider that people can sign in with."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="sso-form" variant="primary" loading={save.busy}>
            {provider ? 'Save' : 'Add provider'}
          </Button>
        </>
      }
    >
      <form
        id="sso-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-3"
      >
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" hint="Shown on the sign-in button: Continue with this name.">
            {(props) => (
              <Input
                {...props}
                value={values.name}
                onChange={(e) => change({ name: e.target.value })}
                maxLength={80}
                autoComplete="off"
                autoFocus
                required
              />
            )}
          </Field>
          <Field
            label="Slug"
            hint={
              provider
                ? 'Lowercase letters, digits and dashes. Changing it changes the redirect URI.'
                : 'Lowercase letters, digits and dashes, such as okta. It becomes part of the redirect URI.'
            }
          >
            {(props) => (
              <Input
                {...props}
                value={values.slug}
                onChange={(e) => change({ slug: e.target.value.toLowerCase() })}
                pattern="[a-z0-9][a-z0-9\-]{1,40}"
                minLength={2}
                maxLength={41}
                title="2 to 41 lowercase letters, digits or dashes"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                required
              />
            )}
          </Field>
          <Field
            label="Issuer URL"
            hint="The address the provider publishes its OpenID configuration under."
            className="sm:col-span-2"
          >
            {(props) => (
              <Input
                {...props}
                type="url"
                value={values.issuer}
                onChange={(e) => change({ issuer: e.target.value })}
                maxLength={300}
                placeholder="https://accounts.example.com"
                autoComplete="off"
                required
              />
            )}
          </Field>
          <Field label="Client ID">
            {(props) => (
              <Input
                {...props}
                value={values.clientId}
                onChange={(e) => change({ clientId: e.target.value })}
                maxLength={300}
                autoComplete="off"
                spellCheck={false}
                required
              />
            )}
          </Field>
          <Field
            label="Client secret"
            optional
            hint={
              provider?.hasClientSecret
                ? 'A secret is stored. Leave empty to keep it.'
                : 'Leave empty if the provider gave you none.'
            }
          >
            {(props) => (
              <Input
                {...props}
                type="password"
                value={values.clientSecret}
                onChange={(e) => change({ clientSecret: e.target.value })}
                maxLength={500}
                autoComplete="new-password"
              />
            )}
          </Field>
          <Field
            label="Scopes"
            hint="Separated by spaces. Must include openid."
            className="sm:col-span-2"
          >
            {(props) => (
              <Input
                {...props}
                value={values.scopes}
                onChange={(e) => change({ scopes: e.target.value })}
                maxLength={300}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                required
              />
            )}
          </Field>
          <Field
            label="Allowed email domains"
            hint="Separate with commas or new lines. Only people whose email address is at one of these domains may sign in with this provider. With no domains, nobody can."
            className="sm:col-span-2"
          >
            {(props) => (
              <Textarea
                {...props}
                value={values.domains}
                onChange={(e) => change({ domains: e.target.value })}
                placeholder="example.com"
                autoCapitalize="none"
                spellCheck={false}
                className="min-h-16"
              />
            )}
          </Field>
        </div>

        <SwitchField
          label="Create accounts automatically on first sign-in"
          hint="When off, only people who already have an account here can sign in with this provider."
          checked={values.autoProvision}
          onChange={(autoProvision) => change({ autoProvision })}
        />
        {values.autoProvision && (
          <Field
            label="Role for new accounts"
            hint="Given on all properties. The organisation admin role cannot be given automatically."
          >
            {(props) => (
              <Select
                {...props}
                value={values.defaultRole}
                onChange={(e) => change({ defaultRole: e.target.value as Role | '' })}
              >
                <option value="">No role, an admin gives one later</option>
                {roles
                  .filter((info) => info.role !== 'org_admin')
                  .map((info) => (
                    <option key={info.role} value={info.role}>
                      {info.label}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        )}
        <SwitchField
          label="Enabled"
          hint="A provider that is not enabled is not offered on the sign-in page."
          checked={values.enabled}
          onChange={(enabled) => change({ enabled })}
        />
      </form>
    </Dialog>
  );
}
