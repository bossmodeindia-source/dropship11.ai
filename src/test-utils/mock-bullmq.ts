import { DynamicModule, Inject, Module } from '@nestjs/common';

export interface MockQueue {
  name: string;
  add: jest.Mock;
  addBulk: jest.Mock;
  getJob: jest.Mock;
  getJobCounts: jest.Mock;
  getWaitingCount: jest.Mock;
  getActiveCount: jest.Mock;
  getFailedCount: jest.Mock;
  getDelayedCount: jest.Mock;
  getActive: jest.Mock;
  getFailed: jest.Mock;
  pause: jest.Mock;
  resume: jest.Mock;
  close: jest.Mock;
  on: jest.Mock;
}

const queueRegistry = new Map<string, MockQueue>();
const commonQueueNames = [
  'product-discovery',
  'creative-generation',
  'paid-campaigns',
  'campaign-launch',
  'organic-posting',
  'shopify-sync',
  'order-processing',
  'supplier-fulfillment',
  'analytics',
  'learning-loop',
  'alerts',
  'dead-letter-queue',
  'telegram:upload',
  'telegram:replication',
  'telegram:health-monitor',
  'telegram:retention',
];

@Module({})
class MockBullModuleHost {}

class MockBullModule {
  static forRoot = jest.fn((): DynamicModule => queueModuleFor(commonQueueNames));
  static forRootAsync = jest.fn((): DynamicModule => queueModuleFor(commonQueueNames));
  static registerQueue = jest.fn((...queues: Array<{ name: string }>): DynamicModule => queueModuleFor(
    queues.map(queueName),
  ));
  static registerQueueAsync = jest.fn((...queues: Array<{ name: string }>): DynamicModule => queueModuleFor(
    queues.map(queueName),
  ));
}

function queueModuleFor(names: string[]): DynamicModule {
  const uniqueNames = [...new Set([...commonQueueNames, ...names].filter(Boolean))];
  return {
    module: MockBullModule,
    global: true,
    providers: uniqueNames.map(queueProvider),
    exports: uniqueNames.map(getMockQueueToken),
  };
}

function queueName(queue: any): string {
  return queue?.name ?? queue?.queueName ?? queue?.options?.name ?? 'default';
}

export function getMockQueueToken(name: string): string {
  return `BullQueue_${name}`;
}

export function createMockQueue(name = 'default'): MockQueue {
  const queue: MockQueue = {
    name,
    add: jest.fn(async (jobName: string, data: unknown) => ({ id: `${name}-job-1`, name: jobName, data })),
    addBulk: jest.fn(async (jobs: unknown[]) => jobs),
    getJob: jest.fn(async () => null),
    getJobCounts: jest.fn(async () => ({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 })),
    getWaitingCount: jest.fn(async () => 0),
    getActiveCount: jest.fn(async () => 0),
    getFailedCount: jest.fn(async () => 0),
    getDelayedCount: jest.fn(async () => 0),
    getActive: jest.fn(async () => []),
    getFailed: jest.fn(async () => []),
    pause: jest.fn(async () => undefined),
    resume: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    on: jest.fn(function (this: MockQueue) {
      return this;
    }),
  };
  queueRegistry.set(name, queue);
  return queue;
}

export function getOrCreateMockQueue(name: string): MockQueue {
  return queueRegistry.get(name) ?? createMockQueue(name);
}

function queueProvider(name: string) {
  return {
    provide: getMockQueueToken(name),
    useValue: getOrCreateMockQueue(name),
  };
}

export function installBullMqMocks(): void {
  jest.doMock('@nestjs/bullmq', () => ({
    __esModule: true,
    BullModule: MockBullModule,
    InjectQueue: (name: string) => Inject(getMockQueueToken(name)),
    getQueueToken: getMockQueueToken,
    Processor: () => () => undefined,
    OnWorkerEvent: () => () => undefined,
    WorkerHost: class WorkerHost {},
  }));

  jest.doMock('bullmq', () => ({
    __esModule: true,
    Queue: class Queue {
      constructor(name: string) {
        return getOrCreateMockQueue(name);
      }
    },
    Worker: class Worker {
      close = jest.fn(async () => undefined);
      on = jest.fn(() => this);
    },
    QueueEvents: class QueueEvents {
      close = jest.fn(async () => undefined);
      on = jest.fn(() => this);
    },
    Job: class Job {},
  }));
}

export function resetMockQueues(): void {
  queueRegistry.clear();
}
