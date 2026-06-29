export {
  CanonicalOutboxEvent,
  OutboxService,
  OutboxStatus,
  outboxEvents,
} from '../common/outbox/outbox.service';

export const OUTBOX_CANONICAL_METHODS = ['enqueueInTx', 'writeWithOutbox'] as const;
