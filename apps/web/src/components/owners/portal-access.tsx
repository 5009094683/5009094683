'use client';

import { Copy, KeyRound, Send } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Badge, Card, Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { KeepFocus } from './keep-focus';
import type { Owner, PortalInvite } from './types';

/** An invitation as it is handed to the admin: where it went, and the link itself. */
interface Invitation {
  email: string;
  emailed: boolean;
  link: string | undefined;
}

/** The single-use link that lets the owner choose a password, for when it could not be emailed. */
function InviteLinkDialog({
  owner,
  invitation,
  onClose,
}: {
  owner: Owner;
  invitation: Invitation;
  onClose: () => void;
}) {
  const toast = useToast();
  const { link } = invitation;
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Invitation link copied');
    } catch {
      // The clipboard is unavailable on plain-HTTP origins and when the browser denies access.
      toast.error('Could not copy. Select the text and copy it yourself.');
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Invitation for ${owner.name}`}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-ink-soft">
        {invitation.emailed ? (
          <p>
            The invitation has been emailed to {invitation.email}. It lets them choose a password,
            works once and expires in three days. The same link is below in case the email does not
            arrive.
          </p>
        ) : (
          <Notice tone="warning">
            The invitation was not emailed to {invitation.email}: no mail server is set up, or it
            did not take the message. Copy this link and hand it over yourself. It lets them choose
            a password, works once and expires in three days.
          </Notice>
        )}
        {link && (
          <Field
            label="Invitation link"
            hint="Shown only now. If it is lost, an organisation admin can create a new one."
          >
            {(props) => (
              <div className="flex gap-2">
                <Input
                  {...props}
                  readOnly
                  value={link}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-w-0 flex-1 font-mono text-[13px]"
                />
                <Button
                  icon={<Copy className="size-4" aria-hidden />}
                  aria-label="Copy invitation link"
                  onClick={() => void copy()}
                >
                  Copy
                </Button>
              </div>
            )}
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function AccessBadge({ owner }: { owner: Owner }) {
  if (!owner.user) return null;
  if (!owner.active || owner.user.status === 'disabled') {
    return <Badge tone="neutral">Access switched off</Badge>;
  }
  if (owner.user.status === 'invited') return <Badge tone="warning">Invited</Badge>;
  return (
    <Badge tone="success">
      <KeyRound className="size-3" aria-hidden />
      Has access
    </Badge>
  );
}

/** Whether the owner can sign in to see their villa, and the way to let them. */
export function PortalAccess({ owner, onChanged }: { owner: Owner; onChanged: () => void }) {
  const auth = useAuth();
  // Creating a sign-in is for those who manage users across the organisation.
  const canInvite = auth.can('org.manage');
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const user = owner.user;

  const invite = useAction(async () => {
    const result = await api<PortalInvite>(`/owners/${owner.id}/portal-access`, {
      method: 'POST',
    });
    setInvitation({
      email: owner.email ?? '',
      emailed: result.inviteEmailed,
      link: result.inviteLink,
    });
    onChanged();
  });

  const inviteAgain = useAction(async () => {
    if (!user) return;
    const result = await api<{ link: string; emailed: boolean }>(`/users/${user.id}/reset-link`, {
      method: 'POST',
    });
    setInvitation({ email: user.email, emailed: result.emailed, link: result.link });
  });

  // The server refuses the first two; the portal itself is closed to an inactive owner.
  const missing = !owner.email
    ? 'Add the owner\u2019s email address first: it becomes their sign-in.'
    : owner.contracts.length === 0
      ? 'Add a contract first, so the portal has something to show.'
      : !owner.active
        ? 'This owner is marked inactive, and the portal is closed to inactive owners. Make them active again under Edit details first.'
        : null;

  return (
    <Card className="p-4 sm:p-5">
      <KeepFocus label="Owner portal">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">Owner portal</h2>
          <AccessBadge owner={owner} />
        </div>

        {user ? (
          <div className="mt-2 flex flex-col gap-2 text-sm text-ink-soft">
            <p>
              Signs in as <span className="font-medium break-words text-ink">{user.email}</span>
            </p>
            {!owner.active ? (
              <p>
                This owner is marked inactive, so the portal is closed to them. Make them active
                again under Edit details.
              </p>
            ) : user.status === 'disabled' ? (
              <p>
                This sign-in has been disabled, so they cannot get in. An organisation admin can
                enable it again under Settings, Users.
              </p>
            ) : user.status === 'invited' ? (
              <>
                <p>
                  They have been invited but have not chosen a password yet. An invitation works
                  once and expires after three days.
                  {!canInvite && ' An organisation admin can create a new one if it has run out.'}
                </p>
                {canInvite && (
                  <>
                    {inviteAgain.error && (
                      <Notice tone="danger">
                        Could not create a new invitation. {inviteAgain.error}
                      </Notice>
                    )}
                    <div>
                      <Button
                        icon={<Send className="size-4" aria-hidden />}
                        loading={inviteAgain.busy}
                        onClick={() => void inviteAgain.run()}
                      >
                        Create a new invitation link
                      </Button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <p>
                They see their own villa only: its bookings without guest names, their own stays,
                and the statements you have issued.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-3 text-sm text-ink-soft">
            <p>
              In the owner portal an owner sees their own villa only: its bookings without guest
              names, the dates they have taken for themselves, and the statements you have issued.
            </p>
            {canInvite ? (
              <>
                {invite.error && <Notice tone="danger">Could not invite. {invite.error}</Notice>}
                {missing ? (
                  <p className="text-ink-faint">{missing}</p>
                ) : (
                  <p>
                    The invitation goes to{' '}
                    <span className="font-medium break-words text-ink">{owner.email}</span>, which
                    becomes their sign-in.
                  </p>
                )}
                <div>
                  <Button
                    icon={<Send className="size-4" aria-hidden />}
                    loading={invite.busy}
                    disabled={missing !== null}
                    onClick={() => void invite.run()}
                  >
                    Invite to the owner portal
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-ink-faint">
                {owner.name} has no access yet. Inviting someone creates a sign-in, which only an
                organisation admin can do: ask one to invite them from this page.
              </p>
            )}
          </div>
        )}
      </KeepFocus>

      {invitation && (
        <InviteLinkDialog
          owner={owner}
          invitation={invitation}
          onClose={() => setInvitation(null)}
        />
      )}
    </Card>
  );
}
