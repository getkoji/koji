/**
 * Pluggable email-sender interface.
 *
 * Default implementation: `SmtpEmailSender` (`./smtp.ts`), Node-only via
 * nodemailer. The hosted Worker passes a different implementation (HTTP-based
 * via Resend / Postmark, or a no-op when Clerk handles the email flows).
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<boolean>;
}

/** No-op sender — logs to console and returns true. Useful when an external
 *  auth provider (Clerk) handles user-lifecycle emails itself and we don't
 *  want the in-product flows to attempt delivery. */
export class ConsoleEmailSender implements EmailSender {
  async send(msg: EmailMessage): Promise<boolean> {
    console.log(
      `[email:console] to=${msg.to} subject=${JSON.stringify(msg.subject)}`,
    );
    return true;
  }
}
