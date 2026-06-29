/**
 * AlertingService — V59 Multi-Channel Alert System
 *
 * Channels:
 *   - Telegram Bot API (instant, for critical alerts)
 *   - Email via SendGrid (for reports + medium-priority alerts)
 *
 * Alert levels:
 *   critical  — immediate Telegram + email (API outages, losses, payment failures)
 *   warn      — Telegram only
 *   info      — email only / optional Telegram
 *
 * Alert triggers:
 *   - Failed campaigns (ROAS < threshold)
 *   - Supplier failures
 *   - API outages (Meta/Shopify)
 *   - Excessive losses (daily loss > cap)
 *   - Payment failures
 *   - System mode changes
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AlertPayload {
  title: string;
  message: string;
  data?: Record<string, unknown>;
  tenantId?: string;
}

@Injectable()
export class AlertingService {
  private readonly logger = new Logger(AlertingService.name);
  private readonly telegramToken: string;
  private readonly telegramChatId: string;
  private readonly sendgridKey: string;
  private readonly alertEmail: string;
  private readonly fromEmail: string;

  constructor(private readonly config: ConfigService) {
    this.telegramToken  = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
    this.telegramChatId = this.config.get<string>('TELEGRAM_ALERT_CHAT_ID', '');
    this.sendgridKey    = this.config.get<string>('SENDGRID_API_KEY', '');
    this.alertEmail     = this.config.get<string>('ALERT_EMAIL', '');
    this.fromEmail      = this.config.get<string>('EMAIL_FROM', 'alerts@aiempirebot.com');
  }

  // ── Public alert methods ──────────────────────────────────────────────────

  async sendCritical(payload: AlertPayload): Promise<void> {
    await Promise.allSettled([
      this.sendTelegram(payload, '🚨 CRITICAL'),
      this.sendEmail(payload, 'critical'),
    ]);
  }

  async sendWarn(payload: AlertPayload): Promise<void> {
    await Promise.allSettled([
      this.sendTelegram(payload, '⚠️ WARNING'),
    ]);
  }

  async sendInfo(payload: AlertPayload): Promise<void> {
    await Promise.allSettled([
      this.sendTelegram(payload, 'ℹ️ INFO'),
    ]);
  }

  // ── Predefined alert types ────────────────────────────────────────────────

  async alertCampaignFailed(tenantId: string, campaignId: string, reason: string): Promise<void> {
    await this.sendWarn({
      title: 'Campaign Failed',
      message: `Campaign ${campaignId} failed for tenant ${tenantId}.\nReason: ${reason}`,
      tenantId,
      data: { campaignId, reason },
    });
  }

  async alertSupplierFailure(tenantId: string, supplierId: string, error: string): Promise<void> {
    await this.sendCritical({
      title: '🏭 Supplier Failure',
      message: `Supplier ${supplierId} failed for tenant ${tenantId}.\nError: ${error}`,
      tenantId,
      data: { supplierId, error },
    });
  }

  async alertApiOutage(service: string, details: string): Promise<void> {
    await this.sendCritical({
      title: `🔴 API Outage: ${service}`,
      message: `${service} is unreachable.\nDetails: ${details}\nSystem entering safe mode.`,
      data: { service, details },
    });
  }

  async alertExcessiveLoss(tenantId: string, spent: number, cap: number): Promise<void> {
    await this.sendCritical({
      title: '💸 Excessive Loss Alert',
      message: `Tenant ${tenantId} has exceeded daily spend cap.\nSpent: $${spent.toFixed(2)} / Cap: $${cap.toFixed(2)}\nAll campaigns paused.`,
      tenantId,
      data: { spent, cap },
    });
  }

  async alertPaymentFailure(tenantId: string, orderId: string, error: string): Promise<void> {
    await this.sendCritical({
      title: '💳 Payment Failure',
      message: `Payment failed for order ${orderId} (tenant ${tenantId}).\nError: ${error}`,
      tenantId,
      data: { orderId, error },
    });
  }

  async alertSystemModeChange(mode: string, reason: string, actor: string): Promise<void> {
    await this.sendWarn({
      title: `⚙️ System Mode: ${mode.toUpperCase()}`,
      message: `System mode changed to ${mode}.\nReason: ${reason}\nBy: ${actor}`,
      data: { mode, reason, actor },
    });
  }

  // ── Telegram ──────────────────────────────────────────────────────────────

  private async sendTelegram(payload: AlertPayload, prefix: string): Promise<void> {
    if (!this.telegramToken || !this.telegramChatId) {
      this.logger.debug('Telegram not configured — skipping');
      return;
    }

    const tenant = payload.tenantId ? `\nTenant: ${payload.tenantId}` : '';
    const dataStr = payload.data
      ? `\n\`\`\`json\n${JSON.stringify(payload.data, null, 2)}\n\`\`\``
      : '';

    const text = [
      `${prefix}: *${this.escapeMarkdown(payload.title)}*`,
      this.escapeMarkdown(payload.message),
      tenant ? this.escapeMarkdown(tenant) : '',
      dataStr,
      `\n_${new Date().toISOString()}_`,
    ].filter(Boolean).join('\n');

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.telegramToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.telegramChatId,
            text,
            parse_mode: 'Markdown',
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`Telegram alert failed: ${res.status} ${body}`);
      }
    } catch (err) {
      this.logger.error(`Telegram alert error: ${(err as Error).message}`);
    }
  }

  // ── Email via SendGrid ────────────────────────────────────────────────────

  private async sendEmail(payload: AlertPayload, severity: string): Promise<void> {
    if (!this.sendgridKey || !this.alertEmail) {
      this.logger.debug('Email not configured — skipping');
      return;
    }

    const html = `
      <div style="font-family:monospace;max-width:600px;margin:0 auto">
        <h2 style="color:${severity === 'critical' ? '#dc2626' : '#f59e0b'}">${payload.title}</h2>
        <p>${payload.message.replace(/\n/g, '<br>')}</p>
        ${payload.tenantId ? `<p><strong>Tenant:</strong> ${payload.tenantId}</p>` : ''}
        ${payload.data ? `<pre style="background:#f3f4f6;padding:12px;border-radius:6px">${JSON.stringify(payload.data, null, 2)}</pre>` : ''}
        <p style="color:#6b7280;font-size:12px">${new Date().toISOString()}</p>
      </div>
    `;

    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.sendgridKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: this.alertEmail }] }],
          from: { email: this.fromEmail, name: 'AI Empire Alerts' },
          subject: `[${severity.toUpperCase()}] ${payload.title}`,
          content: [{ type: 'text/html', value: html }],
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        this.logger.error(`Email alert failed: ${res.status}`);
      }
    } catch (err) {
      this.logger.error(`Email alert error: ${(err as Error).message}`);
    }
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }
}
