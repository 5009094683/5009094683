import nodemailer from 'nodemailer';
import type { Env } from '@pms/config';

export interface MailAttachment {
  filename: string;
  content: string | Buffer;
  contentType?: string;
}

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: MailAttachment[];
}

export interface MailResult {
  /** False when no mail server is configured: the message was not sent. */
  delivered: boolean;
  messageId?: string;
}

export interface Mailer {
  readonly configured: boolean;
  send(message: MailMessage): Promise<MailResult>;
}

type Transport = ReturnType<typeof nodemailer.createTransport>;

class SmtpMailer implements Mailer {
  readonly configured = true;
  constructor(
    private readonly transport: Transport,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<MailResult> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo,
      attachments: message.attachments,
    });
    return { delivered: true, messageId: info.messageId };
  }
}

/**
 * Stands in when no SMTP server is configured. Outside production it prints
 * the message so links (invitations, password resets) are usable while
 * developing. In production it prints only the subject, never the body, which
 * may contain single-use links.
 */
class UnconfiguredMailer implements Mailer {
  readonly configured = false;
  constructor(private readonly printBodies: boolean) {}

  async send(message: MailMessage): Promise<MailResult> {
    const to = Array.isArray(message.to) ? message.to.join(', ') : message.to;
    if (this.printBodies) {
      console.log(`[mail:not-sent] to=${to} subject="${message.subject}"\n${message.text}`);
    } else {
      console.warn(`[mail:not-sent] SMTP_URL is not set; dropped "${message.subject}" for ${to}`);
    }
    return { delivered: false };
  }
}

/** Collects messages in memory. For tests. */
export class MemoryMailer implements Mailer {
  readonly configured = true;
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<MailResult> {
    this.sent.push(message);
    return { delivered: true, messageId: `memory-${this.sent.length}` };
  }

  last(): MailMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}

export function createMailer(
  env: Pick<Env, 'SMTP_URL' | 'MAIL_FROM' | 'isProduction' | 'isTest'>,
): Mailer {
  if (env.SMTP_URL) {
    return new SmtpMailer(nodemailer.createTransport(env.SMTP_URL), env.MAIL_FROM);
  }
  return new UnconfiguredMailer(!env.isProduction && !env.isTest);
}
