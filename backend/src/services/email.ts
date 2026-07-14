import { config } from "../config";

const SENDGRID_API = "https://api.sendgrid.com/v3/mail/send";

/** Check if email sending is configured — needs a SendGrid API key in SMTP_PASS. */
export function isEmailConfigured(): boolean {
  return !!config.email.pass;
}

/**
 * Send a workspace invite email via SendGrid REST API (HTTPS).
 * Uses HTTPS (port 443) — works on all Render plans including free tier.
 */
export async function sendWorkspaceInvite(
  to: string,
  inviteId: string,
  workspaceName: string,
  invitedByName: string,
): Promise<boolean> {
  if (!isEmailConfigured()) {
    console.warn("  EMAIL: SendGrid API key not configured.");
    return false;
  }

  const acceptLink = `${config.email.appUrl}/invite/${inviteId}`;
  const fromDomain = config.email.from.split("@").pop() || "compassmeetings.com";

  try {
    const res = await fetch(SENDGRID_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.email.pass}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: config.email.from, name: config.email.appName },
        subject: `You're invited to join "${workspaceName}" on ${config.email.appName}`,
        content: [
          {
            type: "text/html",
            value: `
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
          },
        ],
      }),
    });

    if (res.ok) {
      console.log(`  EMAIL: Invite sent to ${to} via SendGrid API`);
      return true;
    } else {
      const body = await res.text();
      console.error(`  EMAIL: SendGrid API returned ${res.status}: ${body}`);
      return false;
    }
  } catch (err) {
    console.error(`  EMAIL: Failed to send invite to ${to}:`, err instanceof Error ? err.message : err);
    return false;
  }
}
