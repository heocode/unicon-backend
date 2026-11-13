import { ConfigService } from '@nestjs/config';

import type { NotificationDelivery } from '../../generated/prisma/client';
import type {
  MailEnvelopeContext,
  StoredMailPayload,
} from '../types/mail-delivery.type';
import { MailDeliveryConfigService } from './mail-delivery-config.service';
import { MailDeliveryEncryptionService } from './mail-delivery-encryption.service';

function encryption(active = 1, keys = new Map([[1, Buffer.alloc(32, 9)]])) {
  return new MailDeliveryEncryptionService(
    new MailDeliveryConfigService(
      new ConfigService({
        MAIL_DELIVERY_MAX_AGE_SECONDS: 82800,
        MAIL_DELIVERY_LEASE_SECONDS: 45,
        MAIL_DELIVERY_HTTP_TIMEOUT_SECONDS: 10,
        MAIL_DELIVERY_WORKER_INTERVAL_SECONDS: 1,
        MAIL_DELIVERY_WORKER_BATCH_SIZE: 20,
        NOTIFICATION_DELIVERY_RETENTION_SECONDS: 15552000,
        MAIL_DELIVERY_ENCRYPTION_ACTIVE_KEY_VERSION: active,
        MAIL_DELIVERY_ENCRYPTION_KEYS: keys,
      }),
    ),
  );
}

describe('Mail delivery AEAD envelope', () => {
  const context: MailEnvelopeContext = {
    id: 'job-id',
    idempotencyKey: 'domain-event-key',
    type: 'NEW_SESSION',
    recipient: 'student@example.edu',
    mailExpiresAt: new Date('2026-11-13T00:00:00Z'),
  };
  const payload: StoredMailPayload = {
    content: {
      recipient: context.recipient,
      from: 'Unicon <mail@example.edu>',
      subject: 'Test',
      html: '',
      text: 'temporary-proof',
      inlineAttachments: [],
    },
    guard: {
      kind: 'VERIFICATION',
      userId: 'user-id',
      tokenHash: 'hashed-token',
    },
  };
  const service = encryption();
  function row() {
    return {
      ...context,
      ...service.encrypt(context, payload),
    } as unknown as NotificationDelivery;
  }
  it('round-trips content and guard with fresh random nonces and no plaintext persistence', () => {
    const first = row(),
      second = row();
    expect(service.decrypt(first)).toEqual(payload);
    expect(first.mailIv).not.toEqual(second.mailIv);
    expect(first.mailPayload).not.toEqual(second.mailPayload);
    expect(
      Buffer.from(first.mailPayload!).includes(Buffer.from('temporary-proof')),
    ).toBe(false);
  });
  it.each([
    { id: 'other-job' },
    { idempotencyKey: 'other-key' },
    { type: 'SUSPICIOUS_ACTIVITY' },
    { recipient: 'other@example.edu' },
    { mailExpiresAt: new Date('2026-11-14T00:00:00Z') },
  ])('rejects changing authenticated envelope context %p', (change) => {
    expect(() =>
      service.decrypt({ ...row(), ...change } as NotificationDelivery),
    ).toThrow('Mail payload is unavailable.');
  });
  it('rejects a modified ciphertext or tag', () => {
    const changed = row();
    changed.mailPayload![0] ^= 1;
    expect(() => service.decrypt(changed)).toThrow(
      'Mail payload is unavailable.',
    );
  });
  it('retains old-key readability during rotation while writing with the new active key', () => {
    const old = row(),
      rotated = encryption(
        2,
        new Map([
          [1, Buffer.alloc(32, 9)],
          [2, Buffer.alloc(32, 10)],
        ]),
      );
    expect(rotated.decrypt(old)).toEqual(payload);
    const next = {
      ...context,
      ...rotated.encrypt(context, payload),
    } as unknown as NotificationDelivery;
    expect(next.mailKeyVersion).toBe(2);
    expect(rotated.decrypt(next)).toEqual(payload);
    expect(() => service.decrypt(next)).toThrow('Mail payload is unavailable.');
  });
  it('distinguishes unavailable key/protocol from corrupted content for recoverable deferral', () => {
    const missing = row();
    missing.mailKeyVersion = 99;
    try {
      service.decrypt(missing);
      throw new Error('Expected missing key.');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'KEY_UNAVAILABLE' });
    }
    missing.mailProtocol = 2;
    try {
      service.decrypt(missing);
      throw new Error('Expected unknown protocol.');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'KEY_UNAVAILABLE' });
    }
  });
});
