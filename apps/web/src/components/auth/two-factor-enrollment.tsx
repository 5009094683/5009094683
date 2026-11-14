'use client';

import { Copy, Download, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Notice, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';

/**
 * Walks a user through adding an authenticator app: scan the code, prove it
 * works, then save the recovery codes. `onConfirmed` fires once the code is
 * accepted (two-step verification is on from then), `onDone` when the user
 * says the recovery codes are saved. Keep this mounted between the two: the
 * codes are shown only once.
 */
export function TwoFactorEnrollment({
  onDone,
  onConfirmed,
}: {
  onDone: () => void;
  onConfirmed?: () => void;
}) {
  const toast = useToast();
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ secret: string; otpauthUrl: string }>('/auth/2fa/enroll', { method: 'POST' })
      .then(async (result) => {
        const dataUrl = await QRCode.toDataURL(result.otpauthUrl, { margin: 1, width: 200 });
        if (cancelled) return;
        setEnrollment(result);
        setQr(dataUrl);
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ recoveryCodes: string[] }>('/auth/2fa/confirm', {
        body: { code: code.trim() },
      });
      setRecoveryCodes(result.recoveryCodes);
      onConfirmed?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCodes) {
    const text = recoveryCodes.join('\n');
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="success" title="Two-step verification is on">
          Save these recovery codes somewhere safe. Each one signs you in once if you lose your
          phone. They are not shown again.
        </Notice>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-line bg-sunken p-4 font-mono text-sm text-ink">
          {recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<Copy className="size-4" />}
            onClick={async () => {
              await navigator.clipboard.writeText(text);
              toast.success('Recovery codes copied');
            }}
          >
            Copy
          </Button>
          <Button
            icon={<Download className="size-4" />}
            onClick={() => {
              const link = document.createElement('a');
              link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
              link.download = 'recovery-codes.txt';
              link.click();
              URL.revokeObjectURL(link.href);
            }}
          >
            Download
          </Button>
          <Button variant="primary" className="ml-auto" onClick={onDone}>
            I have saved them
          </Button>
        </div>
      </div>
    );
  }

  if (!enrollment || !qr) {
    return error ? <Notice tone="danger">{error}</Notice> : <PageLoading label="Preparing" />;
  }

  return (
    <form onSubmit={confirm} className="flex flex-col gap-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
        <li>
          Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password,
          Authy).
        </li>
        <li>Scan this code, or enter the key by hand.</li>
        <li>Type the 6-digit code the app shows.</li>
      </ol>
      <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-sunken p-4 sm:flex-row sm:items-start">
        <img
          src={qr}
          alt="QR code for your authenticator app"
          width={160}
          height={160}
          className="rounded-md bg-white p-1"
        />
        <div className="min-w-0 text-[13px] text-ink-soft">
          <p className="font-medium text-ink">Setup key</p>
          <p className="mt-1 font-mono text-sm break-all text-ink select-all">
            {enrollment.secret.replace(/(.{4})/g, '$1 ')}
          </p>
        </div>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <Field label="Verification code">
        {(props) => (
          <Input
            {...props}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            className="max-w-40 text-center text-lg tracking-[0.3em]"
          />
        )}
      </Field>
      <div>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          icon={<ShieldCheck className="size-4" />}
        >
          Turn on two-step verification
        </Button>
      </div>
    </form>
  );
}
