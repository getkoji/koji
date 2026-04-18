/**
 * Email templates — branded HTML emails using the Koji palette.
 *
 * All emails share the same shell: centered container on a cream
 * background, Koji wordmark at top, content area, muted footer.
 * Matches the dashboard aesthetic.
 */

const CREAM = "#F4EEE2";
const CREAM_2 = "#ECE3D0";
const INK = "#171410";
const INK_3 = "#665C4B";
const INK_4 = "#998E78";
const VERMILLION = "#C33520";

function layout(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Koji</title>
</head>
<body style="margin:0;padding:0;background:${CREAM};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">

          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <span style="font-family:Georgia,serif;font-size:28px;font-weight:500;color:${INK};letter-spacing:-0.02em;">koji</span>
            </td>
          </tr>

          <!-- Content card -->
          <tr>
            <td style="background:#ffffff;border:1px solid ${CREAM_2};border-radius:3px;padding:36px 32px;">
              ${content}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0;font-size:11px;color:${INK_4};line-height:1.5;">
                This email was sent by your Koji installation.
                <br />
                If you didn't expect this, you can safely ignore it.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function passwordResetEmail(name: string, resetUrl: string): { subject: string; text: string; html: string } {
  const displayName = name || "there";

  return {
    subject: "Reset your password — Koji",
    text: [
      `Hi ${displayName},`,
      "",
      "We received a request to reset the password for your Koji account.",
      "",
      "Click this link to choose a new password:",
      resetUrl,
      "",
      "This link will expire in 1 hour. If you didn't make this request, no action is needed — your password won't change.",
      "",
      "— The Koji team",
    ].join("\n"),
    html: layout(`
      <h1 style="margin:0 0 8px;font-family:Georgia,serif;font-size:22px;font-weight:500;color:${INK};letter-spacing:-0.01em;">
        Reset your password
      </h1>
      <p style="margin:0 0 24px;font-size:14px;color:${INK_3};line-height:1.6;">
        Hi ${displayName}, we received a request to reset the password for your Koji account.
        Click the button below to choose a new password.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr>
          <td style="border-radius:3px;background:${INK};">
            <a href="${resetUrl}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:500;color:${CREAM};text-decoration:none;border-radius:3px;">
              Reset password
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 16px;font-size:12px;color:${INK_4};line-height:1.5;">
        This link will expire in 1 hour. If you didn't request a password reset, no action is needed — your password won't change.
      </p>
      <hr style="border:none;border-top:1px solid ${CREAM_2};margin:24px 0 16px;" />
      <p style="margin:0;font-size:11px;color:${INK_4};line-height:1.5;">
        If the button doesn't work, copy and paste this URL into your browser:
        <br />
        <a href="${resetUrl}" style="color:${VERMILLION};word-break:break-all;font-size:11px;">${resetUrl}</a>
      </p>
    `),
  };
}

export function welcomeEmail(name: string, loginUrl: string): { subject: string; text: string; html: string } {
  const displayName = name || "there";

  return {
    subject: "Welcome to Koji",
    text: [
      `Hi ${displayName},`,
      "",
      "Your Koji account has been created. You can sign in at:",
      loginUrl,
      "",
      "— The Koji team",
    ].join("\n"),
    html: layout(`
      <h1 style="margin:0 0 8px;font-family:Georgia,serif;font-size:22px;font-weight:500;color:${INK};letter-spacing:-0.01em;">
        Welcome to Koji
      </h1>
      <p style="margin:0 0 24px;font-size:14px;color:${INK_3};line-height:1.6;">
        Hi ${displayName}, your account has been created. You're all set to start extracting structured data from documents.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr>
          <td style="border-radius:3px;background:${INK};">
            <a href="${loginUrl}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:500;color:${CREAM};text-decoration:none;border-radius:3px;">
              Sign in to Koji
            </a>
          </td>
        </tr>
      </table>
    `),
  };
}

export function teamInviteEmail(inviterName: string, projectName: string, inviteUrl: string): { subject: string; text: string; html: string } {
  return {
    subject: `${inviterName} invited you to ${projectName} on Koji`,
    text: [
      `${inviterName} invited you to join "${projectName}" on Koji.`,
      "",
      "Click this link to accept the invitation:",
      inviteUrl,
      "",
      "— The Koji team",
    ].join("\n"),
    html: layout(`
      <h1 style="margin:0 0 8px;font-family:Georgia,serif;font-size:22px;font-weight:500;color:${INK};letter-spacing:-0.01em;">
        You've been invited
      </h1>
      <p style="margin:0 0 24px;font-size:14px;color:${INK_3};line-height:1.6;">
        <strong style="color:${INK};">${inviterName}</strong> invited you to join
        <strong style="color:${INK};">${projectName}</strong> on Koji.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr>
          <td style="border-radius:3px;background:${INK};">
            <a href="${inviteUrl}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:500;color:${CREAM};text-decoration:none;border-radius:3px;">
              Accept invitation
            </a>
          </td>
        </tr>
      </table>
    `),
  };
}
