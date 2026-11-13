'use client';

import { CopyField } from '@/components/settings/fields';

/**
 * The other way in for booking emails: a mail service hands each one over as it arrives. Shown
 * only where the installation has been set up for it.
 */
export function MailboxForwarding({ address }: { address: string }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="text-sm font-semibold text-ink">
        Or have your mail service forward booking emails to this address
      </h3>
      <p className="text-[13px] text-ink-soft">
        For a mail service that can hand over each email to a web address as it arrives. No mailbox
        needs to be entered above then.
      </p>
      <CopyField label="Forwarding address" value={address} />
      <p className="text-[13px] text-ink-soft">
        The address works only together with the inbound email secret of this installation, which
        whoever runs the server knows. The mail service has to send it with every email, as the
        header <code className="font-mono text-xs">x-inbound-email-secret</code> or as{' '}
        <code className="font-mono text-xs">?secret=</code> at the end of the address. Do not share
        the secret, or the address with the secret in it: anyone who has both can hand in emails
        that look like bookings. Emails forwarded while the connection is paused or switched off are
        not kept.
      </p>
    </div>
  );
}
