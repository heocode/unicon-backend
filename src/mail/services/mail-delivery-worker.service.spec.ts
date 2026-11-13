import type { NotificationDelivery } from '../../generated/prisma/client';
import { MailDeliveryRepository } from '../repositories/mail-delivery.repository';
import type { MailWorkResult } from '../types/mail-delivery.type';
import { MailDeliveryConfigService } from './mail-delivery-config.service';
import { MailDeliveryEncryptionService } from './mail-delivery-encryption.service';
import { MailDeliveryWorkerService } from './mail-delivery-worker.service';
import { ResendMailTransportService } from './resend-mail-transport.service';

function setup() {
  const claim = {
    id: 'job-id',
    mailLeaseId: 'lease-id',
  } as NotificationDelivery;
  const repository = {
    claimNext: jest
      .fn<Promise<NotificationDelivery | null>, []>()
      .mockResolvedValue(null),
    prepare: jest.fn().mockResolvedValue({ outcome: 'READY', row: claim }),
    startAttempt: jest.fn().mockResolvedValue('STARTED'),
    sent: jest.fn().mockResolvedValue(true),
    retry: jest.fn().mockResolvedValue('RETRY_SCHEDULED'),
    defer: jest.fn().mockResolvedValue('LEASE_LOST'),
  };
  const payload = {
    content: {
      recipient: 'student@example.edu',
      from: 'mail@example.edu',
      subject: 'Test',
      html: '',
      text: 'Test',
      inlineAttachments: [],
    },
  };
  const encryption = { decrypt: jest.fn().mockReturnValue(payload) };
  const transport = {
    send: jest.fn(
      async (
        _submission: unknown,
        _signal: AbortSignal,
        before: () => Promise<boolean>,
      ) =>
        (await before())
          ? { outcome: 'ACCEPTED', pressurePersistence: 'NOT_REQUIRED' }
          : { outcome: 'NOT_SUBMITTED' },
    ),
  };
  const worker = new MailDeliveryWorkerService(
    repository as unknown as MailDeliveryRepository,
    encryption as unknown as MailDeliveryEncryptionService,
    transport as unknown as ResendMailTransportService,
    {
      intervalSeconds: 1,
      batchSize: 2,
      httpTimeoutSeconds: 10,
    } as MailDeliveryConfigService,
  );
  return { worker, repository, transport, claim };
}

describe('Mail delivery worker ownership and shutdown (unit)', () => {
  it('leaves accepted-but-unrecorded work under its lease instead of scheduling an invented provider failure', async () => {
    const { worker, repository, claim } = setup();
    repository.sent.mockRejectedValue(new Error('private database failure'));
    await expect(worker.process(claim)).rejects.toThrow(
      'private database failure',
    );
    expect(repository.retry).not.toHaveBeenCalled();
    expect(repository.defer).not.toHaveBeenCalled();
  });
  it('never sends after an uncertain attempt-start acknowledgement or refunds its potentially charged lease', async () => {
    const { worker, repository, claim } = setup();
    repository.startAttempt.mockRejectedValue(
      new Error('commit acknowledgement unavailable'),
    );
    repository.defer.mockResolvedValue('LEASE_LOST');
    expect(await worker.process(claim)).toEqual({ outcome: 'LEASE_LOST' });
    expect(repository.sent).not.toHaveBeenCalled();
    expect(repository.retry).not.toHaveBeenCalled();
  });
  it('prevents overlapping cycles and drains the active lane during shutdown', async () => {
    const { worker, repository, claim } = setup();
    repository.claimNext.mockResolvedValueOnce(claim);
    let finish!: (result: MailWorkResult) => void;
    jest.spyOn(worker, 'process').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const active = worker.runOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(await worker.runOnce()).toEqual([]);
    let stopped = false;
    const shutdown = worker.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish({ outcome: 'SENT' });
    await active;
    await shutdown;
    expect(repository.claimNext).toHaveBeenCalledTimes(1);
    expect(await worker.runOnce()).toEqual([]);
  });
  it('clears the scheduler on shutdown', async () => {
    jest.useFakeTimers();
    try {
      const { worker } = setup();
      worker.onModuleInit();
      expect(jest.getTimerCount()).toBe(1);
      await worker.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
