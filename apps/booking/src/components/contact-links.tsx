import { Mail, Phone } from 'lucide-react';
import { cn } from '@/lib/cn';

const LINK = '-mx-2 flex min-h-11 items-center gap-2.5 rounded-lg px-2 hover:bg-sunken';
const TEXT = 'underline decoration-line-strong underline-offset-4';

export interface ContactLinksProps {
  phone: string | null;
  email: string | null;
  className?: string;
}

/** The property's phone number, which dials when pressed, and its email address. */
export function ContactLinks({ phone, email, className }: ContactLinksProps) {
  if (!phone && !email) return null;
  return (
    <ul className={cn('text-[15px]', className)}>
      {phone ? (
        <li>
          <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className={LINK}>
            <Phone className="size-4 shrink-0 text-ink-faint" aria-hidden />
            <span className={TEXT}>{phone}</span>
          </a>
        </li>
      ) : null}
      {email ? (
        <li>
          <a href={`mailto:${email}`} className={LINK}>
            <Mail className="size-4 shrink-0 text-ink-faint" aria-hidden />
            <span className={cn(TEXT, 'break-all')}>{email}</span>
          </a>
        </li>
      ) : null}
    </ul>
  );
}
