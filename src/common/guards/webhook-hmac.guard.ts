/**
 * Re-exports WebhookGuard from orders module for use in other contexts.
 * Kept in common/guards so controllers can @UseGuards(WebhookHmacGuard).
 */
export { WebhookGuard as WebhookHmacGuard } from '../../orders/webhook.guard';
