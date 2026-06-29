import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface WebhookPayload {
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Send transactional email via Resend/SES.
   * In dev, just logs the email.
   */
  async sendEmail(payload: EmailPayload): Promise<void> {
    const isDev = this.config.get('NODE_ENV') !== 'production';
    if (isDev) {
      this.logger.debug(
        `[EMAIL MOCK] To: ${payload.to} | Subject: ${payload.subject}`,
      );
      return;
    }

    const resendKey = this.config.get<string>('RESEND_API_KEY');
    if (!resendKey) {
      this.logger.warn('RESEND_API_KEY not set — skipping email');
      return;
    }

    try {
      await axios.post(
        'https://api.resend.com/emails',
        {
          from:    this.config.get('EMAIL_FROM', 'noreply@dropship-saas.com'),
          to:      payload.to,
          subject: payload.subject,
          html:    payload.html,
          text:    payload.text,
        },
        {
          headers: { Authorization: `Bearer ${resendKey}` },
          timeout: 10_000,
        },
      );
      this.logger.log(`Email sent to ${payload.to}: ${payload.subject}`);
    } catch (err) {
      this.logger.error(
        `Failed to send email to ${payload.to}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Forward domain events to user-registered webhooks.
   */
  async forwardWebhook(
    targetUrl: string,
    payload: WebhookPayload,
    hmacSecret?: string,
  ): Promise<void> {
    try {
      const body    = JSON.stringify(payload);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      if (hmacSecret) {
        const { createHmac } = await import('crypto');
        const sig = createHmac('sha256', hmacSecret).update(body).digest('hex');
        headers['X-Dropship-Signature'] = `sha256=${sig}`;
      }

      await axios.post(targetUrl, body, { headers, timeout: 5_000 });
      this.logger.debug(`Webhook forwarded to ${targetUrl}: ${payload.event}`);
    } catch (err) {
      this.logger.error(
        `Failed to forward webhook to ${targetUrl}: ${(err as Error).message}`,
      );
    }
  }

  async notifyOrderReceived(email: string, orderId: string): Promise<void> {
    await this.sendEmail({
      to:      email,
      subject: 'Order received — we are processing it now',
      html:    `<p>Your order <strong>${orderId}</strong> has been received and is being processed.</p>`,
      text:    `Your order ${orderId} has been received and is being processed.`,
    });
  }

  async notifyOrderFulfilled(
    email: string,
    orderId: string,
    trackingNumber?: string,
  ): Promise<void> {
    await this.sendEmail({
      to:      email,
      subject: 'Your order has been fulfilled 🎉',
      html: `<p>Order <strong>${orderId}</strong> has been fulfilled.${
        trackingNumber ? ` Tracking: <strong>${trackingNumber}</strong>` : ''
      }</p>`,
    });
  }

  async notifyOrderFailed(email: string, orderId: string): Promise<void> {
    await this.sendEmail({
      to:      email,
      subject: 'Order fulfillment issue — action required',
      html:    `<p>We encountered an issue fulfilling order <strong>${orderId}</strong>. Our team has been notified and will follow up shortly.</p>`,
    });
  }

  /**
   * FIX 5: Alert ops/admin team when an order is permanently dead-lettered.
   *
   * Sends to ADMIN_ALERT_EMAIL env var (required for production).
   * In dev, logs at ERROR level — always visible, never silent.
   * Never throws — callers (DlqProcessor) handle their own error logging.
   */
  async notifyAdminOrderFailed(orderId: string, reason: string): Promise<void> {
    const adminEmail = this.config.get<string>(
      'ADMIN_ALERT_EMAIL',
      'ops@dropship-saas.com',
    );

    // Always emit at ERROR level regardless of environment
    this.logger.error(
      `[ADMIN ALERT] Order permanently failed | orderId=${orderId} | reason=${reason}`,
    );

    await this.sendEmail({
      to:      adminEmail,
      subject: `🚨 CRITICAL: Order ${orderId} permanently failed — manual action required`,
      html: `
        <h2 style="color:#c0392b">⚠️ Order Fulfillment Failure — Dead Letter Queue</h2>
        <table cellpadding="8" style="border-collapse:collapse;font-family:monospace">
          <tr><td><strong>Order ID</strong></td><td>${orderId}</td></tr>
          <tr><td><strong>Reason</strong></td><td>${reason}</td></tr>
          <tr><td><strong>Time</strong></td><td>${new Date().toISOString()}</td></tr>
        </table>
        <p>This order has exhausted all automatic retry attempts and is now in the Dead Letter Queue.</p>
        <p><strong>Manual intervention required.</strong></p>
        <p>Check the DLQ in BullMQ dashboard or run: <code>SELECT * FROM orders WHERE id = '${orderId}'</code></p>
      `,
      text: `CRITICAL: Order ${orderId} permanently failed. Reason: ${reason}. Manual intervention required. Time: ${new Date().toISOString()}`,
    });
  }

  async sendCritical(payload: { title: string; message: string; data?: Record<string, unknown> }): Promise<void> {
    this.logger.error(`[CRITICAL] ${payload.title}: ${payload.message}`);
  }

  async sendWarn(payload: { title: string; message: string; data?: Record<string, unknown> }): Promise<void> {
    this.logger.warn(`[WARN] ${payload.title}: ${payload.message}`);
  }
}
