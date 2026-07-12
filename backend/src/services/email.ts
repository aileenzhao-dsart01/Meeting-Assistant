import nodemailer from "nodemailer";
import { config } from "../config";

/** Create a reusable transporter (lazy-initialized). */
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  if (!config.email.host || !config.email.user) {
    console.warn("  EMAIL: SMTP not configured — emails will not be sent.");
    return null;
  }

  transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: {
      user: config.email.user,
      pass: config.email.pass,
    },
  });

  return transporter;
}

/** Check if email sending is configured. */
export function isEmailConfigured(): boolean {
  return !!(config.email.host && config.email.user);
}

/**
 * Send a workspace invite email.
 * @param to Recipient email address
 * @param inviteId The invite record ID (used in the accept link)
 * @param workspaceName Name of the workspace they're invited to
 * @param invitedByName Name of the person who invited them
 */
export async function sendWorkspaceInvite(
  to: string,
  inviteId: string,
  workspaceName: string,
  invitedByName: string,
): Promise<boolean> {
  const t = getTransporter();
  if (!t) return false;

  const acceptLink = `${config.email.appUrl}/invite/${inviteId}`;

  try {
    await t.sendMail({
      from: `"${config.email.appName}" <${config.email.from}>`,
      to,
      subject: `You're invited to join "${workspaceName}" on ${config.email.appName}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
          <h2 style="color: #1e1e2e; margin: 0 0 8px;">You're invited!</h2>
          <p style="color: #6b7280; margin: 0 0 24px; line-height: 1.5;">
            <strong>${invitedByName}</strong> has invited you to join the workspace
            <strong>"${workspaceName}"</strong> on ${config.email.appName}.
          </p>
          <a href="${acceptLink}"
             style="display: inline-block; background: #6366f1; color: white; text-decoration: none;
                    padding: 12px 28px; border-radius: 8px; font-size: 15px; font-weight: 600;">
            Accept Invite
          </a>
          <p style="color: #9ca3af; font-size: 13px; margin-top: 24px; line-height: 1.5;">
            This link will accept the invite and add you to the workspace.
            If you did not expect this invite, you can ignore this email.
          </p>
        </div>
      `,
    });
    console.log(`  EMAIL: Invite sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`  EMAIL: Failed to send invite to ${to}:`, err instanceof Error ? err.message : err);
    return false;
  }
}
