import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from '../notifications.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const configMock = {
  get: jest.fn((key: string, def?: unknown) => {
    const map: Record<string, unknown> = {
      NODE_ENV: 'test',           // triggers mock path
      RESEND_API_KEY: undefined,
      EMAIL_FROM: 'noreply@test.com',
    };
    return map[key] ?? def;
  }),
};

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();
    service = module.get<NotificationsService>(NotificationsService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('sendEmail()', () => {
    it('resolves without throwing in test/dev mode', async () => {
      await expect(service.sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        html: '<p>Hello</p>',
      })).resolves.not.toThrow();
    });
  });

  describe('forwardWebhook()', () => {
    it('does not throw on network error (fire-and-forget)', async () => {
      // Calling with an unreachable URL — should not throw
      jest.spyOn(axios, 'post').mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(service.forwardWebhook(
        'https://unreachable.localhost.invalid/hook',
        { event: 'order.fulfilled', data: {}, timestamp: new Date().toISOString() },
      )).resolves.not.toThrow();
    });
  });

  describe('convenience methods', () => {
    it('notifyOrderReceived resolves', async () => {
      await expect(service.notifyOrderReceived('u@t.com', 'order-1')).resolves.not.toThrow();
    });

    it('notifyOrderFulfilled resolves with tracking number', async () => {
      await expect(service.notifyOrderFulfilled('u@t.com', 'order-1', 'TRACK123')).resolves.not.toThrow();
    });

    it('notifyOrderFailed resolves', async () => {
      await expect(service.notifyOrderFailed('u@t.com', 'order-1')).resolves.not.toThrow();
    });
  });
});
