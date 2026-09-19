// Email Service for sending account notifications via Brevo (Sendinblue) API
// Uses HTTP-based Brevo API to avoid SMTP port blocking on cloud platforms (e.g., Render free tier)

import { BREVO_API_KEY, EMAIL_USER, EMAIL_FROM_NAME } from '../env';

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

export interface IEmailService {
  sendAccountInactivatedEmail(
    email: string,
    username: string
  ): Promise<boolean>;
  sendAccountReactivatedEmail(
    email: string,
    username: string
  ): Promise<boolean>;
}

/**
 * Email Service implementation using Brevo HTTP API
 * No SDK required — uses native fetch() to POST to Brevo's transactional email endpoint
 */
class EmailService implements IEmailService {
  private readonly apiUrl = 'https://api.brevo.com/v3/smtp/email';

  /**
   * Check if email service is configured
   */
  private isConfigured(): boolean {
    return BREVO_API_KEY !== '' && EMAIL_USER !== '';
  }

  /**
   * Send an email via Brevo's transactional email API
   */
  private async sendEmail(
    to: string,
    subject: string,
    html: string
  ): Promise<boolean> {
    const response = await fetch(this.apiUrl, {
      signal: AbortSignal.timeout(10_000),
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
      const errorBody = await response.text();
      throw new Error(`Brevo API error ${response.status}: ${errorBody}`);
    }

    return true;
  }

  /**
   * Send notification when account is inactivated
   * @param email - User's email address
   * @param username - User's username
   * @returns Promise<boolean> - true if email sent successfully
   */
  async sendAccountInactivatedEmail(
    email: string,
    username: string
  ): Promise<boolean> {
    if (!this.isConfigured()) {
      console.log(
        `[EmailService ${new Date().toISOString()}] Email not configured. Skipping inactivation email for ${username}`
      );
      return false;
    }

    try {
      await this.sendEmail(
        email,
        `${EMAIL_FROM_NAME} - Your Account Has Been Deactivated`,
        `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #c41230;">Account Deactivated</h2>
            <p>Hello <strong>${escapeHtml(username)}</strong>,</p>
            <p>Your ${EMAIL_FROM_NAME} account has been deactivated by an administrator.</p>
            <p>If you believe this is an error or would like to request reactivation, 
               please contact your administrator.</p>
            <hr style="border: 1px solid #eee; margin: 20px 0;">
            <p style="color: #666; font-size: 12px;">
              This is an automated message from ${EMAIL_FROM_NAME}. Please do not reply to this email.
            </p>
          </div>
        `
      );
      console.log(
        `[EmailService ${new Date().toISOString()}] Account inactivation email sent to ${email} for user ${username}`
      );
      return true;
    } catch (error) {
      console.error(
        `[EmailService ${new Date().toISOString()}] Failed to send inactivation email:`,
        error
      );
      return false;
    }
  }

  /**
   * Send notification when account is reactivated
   * @param email - User's email address
   * @param username - User's username
   * @returns Promise<boolean> - true if email sent successfully
   */
  async sendAccountReactivatedEmail(
    email: string,
    username: string
  ): Promise<boolean> {
    if (!this.isConfigured()) {
      console.log(
        `[EmailService ${new Date().toISOString()}] Email not configured. Skipping reactivation email for ${username}`
      );
      return false;
    }

    try {
      await this.sendEmail(
        email,
        `${EMAIL_FROM_NAME} - Your Account Has Been Reactivated`,
        `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2e7d32;">Account Reactivated</h2>
            <p>Hello <strong>${escapeHtml(username)}</strong>,</p>
            <p>Great news! Your ${EMAIL_FROM_NAME} account has been reactivated.</p>
            <p>You can now log in and access all your account features.</p>
            <hr style="border: 1px solid #eee; margin: 20px 0;">
            <p style="color: #666; font-size: 12px;">
              This is an automated message from ${EMAIL_FROM_NAME}. Please do not reply to this email.
            </p>
          </div>
        `
      );
      console.log(
        `[EmailService ${new Date().toISOString()}] Account reactivation email sent to ${email} for user ${username}`
      );
      return true;
    } catch (error) {
      console.error(
        `[EmailService ${new Date().toISOString()}] Failed to send reactivation email:`,
        error
      );
      return false;
    }
  }
}

// Export singleton instance
export default new EmailService();
