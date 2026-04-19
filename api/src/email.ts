/**
 * Email service — sends via SMTP.
 *
 * In dev/self-hosted: Mailpit catches everything at smtp://localhost:1025.
 * In production/enterprise: configure SMTP_HOST to point at SES/Resend/Postmark.
 *
 * Uses nodemailer for SMTP transport. Falls back to console logging
 * if SMTP is unavailable (so the app doesn't crash on email failure).
 */
import { createTransport, type Transporter } from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST ?? "localhost";
const SMTP_PORT = parseInt(process.env.SMTP_PORT ?? "1025", 10);
const SMTP_FROM = process.env.SMTP_FROM ?? "koji@localhost";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) {
    transport = createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      ...(SMTP_USER ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
    });
  }
  return transport;
}

export async function sendEmail(options: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<boolean> {
  try {
    await getTransport().sendMail({
      from: SMTP_FROM,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
    return true;
  } catch (err) {
    console.warn(`[koji-email] Failed to send to ${options.to}: ${err}`);
    return false;
  }
}
