// Account-status emails sent through Brevo's HTTP API (SMTP ports are often
// blocked on hosted platforms). Disabled unless BREVO_API_KEY and EMAIL_USER
// are configured.

import { BREVO_API_KEY, EMAIL_USER, EMAIL_FROM_NAME } from '../env';
import { createLogger } from '../logger';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 10_000;

const log = createLogger('EmailService');

type AccountStatusChange = 'deactivated' | 'reactivated';

const STATUS_EMAILS: Record<
  AccountStatusChange,
  { subject: string; heading: string; color: string; body: string }
> = {
  deactivated: {
    subject: 'Your Account Has Been Deactivated',
    heading: 'Account Deactivated',
    color: '#c41230',
    body: `<p>Your ${EMAIL_FROM_NAME} account has been deactivated by an administrator.</p>
            <p>If you believe this is an error or would like to request reactivation,
               please contact your administrator.</p>`
  },
  reactivated: {
    subject: 'Your Account Has Been Reactivated',
    heading: 'Account Reactivated',
    color: '#2e7d32',
    body: `<p>Great news! Your ${EMAIL_FROM_NAME} account has been reactivated.</p>
            <p>You can now log in and access all your account features.</p>`
  }
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[character]!
  );
}

function renderStatusEmail(change: AccountStatusChange, username: string) {
  const content = STATUS_EMAILS[change];
  return {
    subject: `${EMAIL_FROM_NAME} - ${content.subject}`,
    html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: ${content.color};">${content.heading}</h2>
            <p>Hello <strong>${escapeHtml(username)}</strong>,</p>
            ${content.body}
            <hr style="border: 1px solid #eee; margin: 20px 0;">
            <p style="color: #666; font-size: 12px;">
              This is an automated message from ${EMAIL_FROM_NAME}. Please do not reply to this email.
            </p>
          </div>
        `
  };
}

class EmailService {
  sendAccountInactivatedEmail(email: string, username: string): Promise<boolean> {
    return this.sendStatusEmail('deactivated', email, username);
  }

  sendAccountReactivatedEmail(email: string, username: string): Promise<boolean> {
    return this.sendStatusEmail('reactivated', email, username);
  }

  /** Resolves true when the email was accepted; failures are logged, not thrown. */
  private async sendStatusEmail(
    change: AccountStatusChange,
    email: string,
    username: string
  ): Promise<boolean> {
    if (!BREVO_API_KEY || !EMAIL_USER) {
      log.info(`Email not configured. Skipping ${change} email for ${username}`);
      return false;
    }

    try {
      const { subject, html } = renderStatusEmail(change, username);
      await this.send(email, subject, html);
      log.info(`Account ${change} email sent to ${email} for user ${username}`);
      return true;
    } catch (error) {
      log.error(`Failed to send ${change} email:`, error);
      return false;
    }
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    const response = await fetch(BREVO_API_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: { name: EMAIL_FROM_NAME, email: EMAIL_USER },
        to: [{ email: to }],
        subject,
        htmlContent: html
      })
    });
    if (!response.ok) {
      throw new Error(
        `Brevo API error ${response.status}: ${await response.text()}`
      );
    }
  }
}

export default new EmailService();
