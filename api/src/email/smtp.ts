/**
 * SMTP-backed EmailSender for the Node self-hosted server.
 *
 * In dev/self-hosted: Mailpit catches everything at smtp://localhost:1025.
 * In production self-hosted: configure SMTP_HOST to point at SES / Resend /
 * Postmark. Falls back to console logging on transport failure so the app
 * doesn't crash if the mail server is misconfigured.
 *
 * This module is Node-only — it pulls in `nodemailer`, which is not
 * Cloudflare Workers-compatible. The hosted deployment uses a different
 * EmailSender implementation (or `ConsoleEmailSender`) — see
 * `email/provider.ts`.
 */

import { createTransport, type Transporter } from "nodemailer";
import type { EmailMessage, EmailSender } from "./provider";

export interface SmtpEmailConfig {
  host: string;
  port: number;
  from: string;
  user?: string;
  pass?: string;
}

export class SmtpEmailSender implements EmailSender {
  private readonly cfg: SmtpEmailConfig;
  private transport: Transporter | null = null;

  constructor(cfg: SmtpEmailConfig) {
    this.cfg = cfg;
  }

  private getTransport(): Transporter {
    if (!this.transport) {
      this.transport = createTransport({
        host: this.cfg.host,
        port: this.cfg.port,
        secure: this.cfg.port === 465,
        ...(this.cfg.user
          ? { auth: { user: this.cfg.user, pass: this.cfg.pass } }
          : {}),
      });
    }
    return this.transport;
  }

  async send(msg: EmailMessage): Promise<boolean> {
    try {
      await this.getTransport().sendMail({
        from: this.cfg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      return true;
    } catch (err) {
      console.warn(`[koji-email] Failed to send to ${msg.to}: ${err}`);
      return false;
    }
  }
}
