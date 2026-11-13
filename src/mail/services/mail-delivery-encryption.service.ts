import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { NotificationDelivery } from '../../generated/prisma/client';
import type {
  MailEnvelopeContext,
  StoredMailPayload,
} from '../types/mail-delivery.type';
import {
  MailDeliveryConfigService,
  MailPayloadError,
} from './mail-delivery-config.service';

@Injectable()
export class MailDeliveryEncryptionService {
  constructor(private readonly config: MailDeliveryConfigService) {}

  encrypt(context: MailEnvelopeContext, payload: StoredMailPayload) {
    const version = this.config.activeKeyVersion,
      key = this.config.key(version);
    const plaintext = Buffer.from(JSON.stringify(payload));
    try {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(this.aad(context, version));
      return {
        mailPayload: Buffer.concat([cipher.update(plaintext), cipher.final()]),
        mailIv: iv,
        mailTag: cipher.getAuthTag(),
        mailProtocol: 1,
        mailKeyVersion: version,
      };
    } finally {
      key.fill(0);
      plaintext.fill(0);
    }
  }

  decrypt(row: NotificationDelivery): StoredMailPayload {
    if (row.mailProtocol !== 1) throw new MailPayloadError('KEY_UNAVAILABLE');
    const key = this.config.key(row.mailKeyVersion!);
    let plaintext: Buffer | undefined;
    try {
      if (!row.mailExpiresAt || !row.mailIv || !row.mailTag || !row.mailPayload)
        throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, row.mailIv);
      decipher.setAAD(
        this.aad(
          { ...row, mailExpiresAt: row.mailExpiresAt },
          row.mailKeyVersion!,
        ),
      );
      decipher.setAuthTag(Buffer.from(row.mailTag));
      plaintext = Buffer.concat([
        decipher.update(row.mailPayload),
        decipher.final(),
      ]);
      const value: unknown = JSON.parse(plaintext.toString('utf8'));
      if (!isStoredPayload(value, row.recipient)) throw new Error();
      return value;
    } catch {
      throw new MailPayloadError('INVALID_ENVELOPE');
    } finally {
      key.fill(0);
      plaintext?.fill(0);
    }
  }

  private aad(context: MailEnvelopeContext, keyVersion: number): Buffer {
    return Buffer.from(
      JSON.stringify([
        'unicon.mail.delivery.envelope.v1',
        1,
        keyVersion,
        context.id,
        context.idempotencyKey,
        context.type,
        context.recipient,
        context.mailExpiresAt.toISOString(),
      ]),
    );
  }
}

function isStoredPayload(
  value: unknown,
  recipient: string,
): value is StoredMailPayload {
  if (!value || typeof value !== 'object' || !('content' in value))
    return false;
  const content = value.content;
  if (!content || typeof content !== 'object') return false;
  for (const name of ['recipient', 'from', 'subject', 'text', 'html'])
    if (!(name in content) || typeof content[name] !== 'string') return false;
  if (
    !('recipient' in content) ||
    content.recipient !== recipient ||
    !('inlineAttachments' in content) ||
    !Array.isArray(content.inlineAttachments) ||
    content.inlineAttachments.length !== 0
  )
    return false;
  if ('guard' in value && value.guard !== undefined) {
    const guard = value.guard;
    if (
      !guard ||
      typeof guard !== 'object' ||
      !('kind' in guard) ||
      !['VERIFICATION', 'PASSWORD_RESET'].includes(String(guard.kind)) ||
      !('userId' in guard) ||
      typeof guard.userId !== 'string' ||
      !('tokenHash' in guard) ||
      typeof guard.tokenHash !== 'string'
    )
      return false;
    if (
      guard.kind === 'PASSWORD_RESET' &&
      (!('tokenId' in guard) || typeof guard.tokenId !== 'string')
    )
      return false;
  }
  return true;
}
