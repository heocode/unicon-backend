import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  Prisma,
  type NotificationDelivery,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  MailProofGuard,
  MailTransaction,
  QueueMailInput,
  StoredMailPayload,
} from '../types/mail-delivery.type';
import { MailDeliveryConfigService } from '../services/mail-delivery-config.service';
import { MailDeliveryEncryptionService } from '../services/mail-delivery-encryption.service';
import { retryAfterBoundary } from '../utils/mail-provider-pressure.util';

const clearedEnvelope = {
  mailPayload: null,
  mailIv: null,
  mailTag: null,
  mailProtocol: null,
  mailKeyVersion: null,
};
const clearedLease = {
  mailLeaseId: null,
  mailLeaseExpiresAt: null,
  mailAttemptStarted: false,
};

@Injectable()
export class MailDeliveryRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: MailDeliveryConfigService,
    private readonly encryption: MailDeliveryEncryptionService,
  ) {}

  enqueue(
    input: QueueMailInput,
    transaction?: MailTransaction,
  ): Promise<string> {
    if (transaction) return this.enqueueInTransaction(transaction, input);
    return this.prisma.$transaction(
      (tx) => this.enqueueInTransaction(tx, input),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private async enqueueInTransaction(
    tx: MailTransaction,
    input: QueueMailInput,
  ): Promise<string> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('unicon.mail.enqueue.v1:' || ${input.idempotencyKey}, 0))`;
    const existing = await tx.notificationDelivery.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, status: true, mailQueuedAt: true },
    });
    if (existing) {
      if (!existing.mailQueuedAt && existing.status !== 'SENT')
        throw new Error(
          'Historical notification has no immutable mail snapshot.',
        );
      return existing.id;
    }
    const now = await this.now(tx);
    const proofExpires = input.guard
      ? await this.guardExpiry(tx, input.guard, input.content.recipient, now)
      : undefined;
    if (input.guard && !proofExpires)
      throw new Error('Mail proof is unavailable.');
    const deadline = new Date(
      Math.min(
        now.getTime() + this.config.maxAgeSeconds * 1000,
        proofExpires?.getTime() ?? Infinity,
      ),
    );
    if (deadline <= now) throw new Error('Mail delivery window is closed.');
    const id = randomUUID();
    const payload: StoredMailPayload = {
      content: {
        ...input.content,
        text: input.content.text ?? '',
        html: input.content.html ?? '',
        inlineAttachments: [],
      },
      ...(input.guard ? { guard: input.guard } : {}),
    };
    const envelope = this.encryption.encrypt(
      {
        id,
        idempotencyKey: input.idempotencyKey,
        type: input.type,
        recipient: input.content.recipient,
        mailExpiresAt: deadline,
      },
      payload,
    );
    await tx.notificationDelivery.create({
      data: {
        id,
        idempotencyKey: input.idempotencyKey,
        type: input.type,
        channel: 'EMAIL',
        recipient: input.content.recipient,
        userId: input.userId,
        sessionId: input.sessionId,
        createdAt: now,
        mailQueuedAt: now,
        mailExpiresAt: deadline,
        retentionExpiresAt: new Date(
          now.getTime() + this.config.retentionSeconds * 1000,
        ),
        ...envelope,
      },
    });
    return id;
  }

  claimNext(): Promise<NotificationDelivery | null> {
    return this.prisma.$transaction(async (tx) => {
      const now = await this.now(tx);
      const rows = await tx.$queryRaw<NotificationDelivery[]>`
        SELECT * FROM "NotificationDelivery"
        WHERE "status"='PENDING' AND "mailQueuedAt" IS NOT NULL
          AND ("mailLeaseId" IS NULL OR "mailLeaseExpiresAt" <= ${now})
          AND ("mailNextAttemptAt" IS NULL OR "mailNextAttemptAt" <= ${now} OR "mailExpiresAt" <= ${now} OR "mailAttemptCount" >= 5)
        ORDER BY COALESCE("mailLeaseExpiresAt", "mailNextAttemptAt", "mailQueuedAt"), "id"
        FOR UPDATE SKIP LOCKED LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return tx.notificationDelivery.update({
        where: { id: row.id },
        data: {
          mailLeaseId: randomUUID(),
          mailLeaseExpiresAt: new Date(
            now.getTime() + this.config.leaseSeconds * 1000,
          ),
          mailAttemptStarted: false,
          mailNextAttemptAt: null,
          updatedAt: now,
        },
      });
    });
  }

  prepare(
    claim: NotificationDelivery,
  ): Promise<
    | { outcome: 'READY'; row: NotificationDelivery }
    | { outcome: 'FAILED' | 'LEASE_LOST' }
  > {
    return this.prisma.$transaction(async (tx) => {
      const state = await this.owned(tx, claim);
      if (!state) return { outcome: 'LEASE_LOST' };
      const reason = this.closedReason(state.row, state.now);
      if (reason) {
        await this.terminal(tx, state.row, state.now, reason);
        return { outcome: 'FAILED' };
      }
      return { outcome: 'READY', row: state.row };
    });
  }

  startAttempt(
    claim: NotificationDelivery,
    payload: StoredMailPayload,
  ): Promise<'STARTED' | 'FAILED' | 'LEASE_LOST'> {
    return this.prisma.$transaction(async (tx) => {
      const state = await this.owned(tx, claim);
      if (!state) return 'LEASE_LOST';
      const reason = this.closedReason(state.row, state.now);
      if (
        reason ||
        (payload.guard &&
          !(await this.guardExpiry(
            tx,
            payload.guard,
            state.row.recipient,
            state.now,
          )))
      ) {
        await this.terminal(
          tx,
          state.row,
          state.now,
          reason ?? 'MAIL_PROOF_UNAVAILABLE',
        );
        return 'FAILED';
      }
      if (state.row.mailAttemptStarted) return 'LEASE_LOST';
      await tx.notificationDelivery.updateMany({
        where: this.ownerWhere(claim, state.now),
        data: {
          mailAttemptStarted: true,
          mailAttemptCount: { increment: 1 },
          attemptedAt: state.now,
          updatedAt: state.now,
        },
      });
      return 'STARTED';
    });
  }

  defer(
    claim: NotificationDelivery,
    boundary?: bigint,
  ): Promise<'DEFERRED' | 'FAILED' | 'LEASE_LOST'> {
    return this.prisma.$transaction(async (tx) => {
      const state = await this.owned(tx, claim);
      if (!state || state.row.mailAttemptStarted) return 'LEASE_LOST';
      const reason = this.closedReason(state.row, state.now);
      if (reason) {
        await this.terminal(tx, state.row, state.now, reason);
        return 'FAILED';
      }
      const requested =
        boundary === undefined
          ? BigInt(state.now.getTime() + this.config.intervalSeconds * 1000)
          : (boundary + 999n) / 1000n;
      const deadline = BigInt(state.row.mailExpiresAt!.getTime());
      await tx.notificationDelivery.updateMany({
        where: this.ownerWhere(claim, state.now),
        data: {
          ...clearedLease,
          mailNextAttemptAt: new Date(
            Number(requested < deadline ? requested : deadline),
          ),
          updatedAt: state.now,
        },
      });
      return 'DEFERRED';
    });
  }

  sent(
    claim: NotificationDelivery,
    providerMessageId?: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const state = await this.owned(tx, claim);
      if (!state) return false;
      await tx.notificationDelivery.updateMany({
        where: this.ownerWhere(claim, state.now),
        data: {
          status: 'SENT',
          providerMessageId,
          sentAt: state.now,
          failureCode: null,
          ...clearedEnvelope,
          ...clearedLease,
          mailNextAttemptAt: null,
          updatedAt: state.now,
        },
      });
      return true;
    });
  }

  fail(claim: NotificationDelivery, code: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const state = await this.owned(tx, claim);
      if (!state) return false;
      await this.terminal(tx, state.row, state.now, code);
      return true;
    });
  }

  retry(
    claim: NotificationDelivery,
    code: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<'RETRY_SCHEDULED' | 'FAILED' | 'LEASE_LOST'> {
    return this.prisma.$transaction(async (tx) => {
      const state = await this.owned(tx, claim);
      if (!state) return 'LEASE_LOST';
      const count = state.row.mailAttemptCount;
      if (!state.row.mailAttemptStarted)
        throw new Error('Mail attempt is not started.');
      if (count >= 5) {
        await this.terminal(
          tx,
          state.row,
          state.now,
          'MAIL_ATTEMPTS_EXHAUSTED',
        );
        return 'FAILED';
      }
      const nowMicros = BigInt(state.now.getTime()) * 1000n;
      const policy = nowMicros + BigInt([5, 15, 30, 60][count - 1]) * 1000000n;
      const provider = retryAfterBoundary(headers, nowMicros) ?? nowMicros;
      const boundary = provider > policy ? provider : policy;
      if (boundary >= BigInt(state.row.mailExpiresAt!.getTime()) * 1000n) {
        await this.terminal(
          tx,
          state.row,
          state.now,
          'MAIL_DELIVERY_WINDOW_CLOSED',
        );
        return 'FAILED';
      }
      await tx.notificationDelivery.updateMany({
        where: this.ownerWhere(claim, state.now),
        data: {
          ...clearedLease,
          mailNextAttemptAt: new Date(Number((boundary + 999n) / 1000n)),
          failureCode: code,
          updatedAt: state.now,
        },
      });
      return 'RETRY_SCHEDULED';
    });
  }

  private closedReason(row: NotificationDelivery, now: Date): string | null {
    if (row.mailExpiresAt! <= now) return 'MAIL_DELIVERY_EXPIRED';
    if (row.mailAttemptCount >= 5 && !row.mailAttemptStarted)
      return 'MAIL_ATTEMPTS_EXHAUSTED';
    return null;
  }
  private async terminal(
    tx: MailTransaction,
    row: NotificationDelivery,
    now: Date,
    code: string,
  ) {
    await tx.notificationDelivery.updateMany({
      where: this.ownerWhere(row, now),
      data: {
        status: 'FAILED',
        failureCode: code,
        ...clearedEnvelope,
        ...clearedLease,
        mailNextAttemptAt: null,
        updatedAt: now,
      },
    });
  }
  private ownerWhere(claim: NotificationDelivery, now: Date) {
    return {
      id: claim.id,
      status: 'PENDING' as const,
      mailLeaseId: claim.mailLeaseId,
      mailLeaseExpiresAt: { gt: now },
    };
  }
  private async owned(tx: MailTransaction, claim: NotificationDelivery) {
    const [row] = await tx.$queryRaw<
      NotificationDelivery[]
    >`SELECT * FROM "NotificationDelivery" WHERE "id"=${claim.id} AND "status"='PENDING' AND "mailLeaseId"=${claim.mailLeaseId}::uuid FOR UPDATE`;
    const now = await this.now(tx);
    if (!row || !row.mailLeaseExpiresAt || row.mailLeaseExpiresAt <= now)
      return null;
    return { row, now };
  }
  private async now(tx: MailTransaction): Promise<Date> {
    const [row] = await tx.$queryRaw<
      { milliseconds: string }[]
    >`SELECT ceil(EXTRACT(EPOCH FROM clock_timestamp())*1000)::text AS "milliseconds"`;
    return new Date(Number(row.milliseconds));
  }
  private async guardExpiry(
    tx: MailTransaction,
    guard: MailProofGuard,
    recipient: string,
    now: Date,
  ): Promise<Date | null> {
    if (guard.kind === 'VERIFICATION') {
      const user = await tx.user.findFirst({
        where: {
          id: guard.userId,
          email: recipient,
          status: 'PENDING',
          hashedVerificationToken: guard.tokenHash,
          verificationTokenExpires: { gt: now },
        },
        select: { verificationTokenExpires: true },
      });
      return user?.verificationTokenExpires ?? null;
    }
    const token = await tx.passwordResetToken.findFirst({
      where: {
        id: guard.tokenId,
        userId: guard.userId,
        tokenHash: guard.tokenHash,
        usedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: now },
        user: { status: 'ACTIVE', email: recipient },
      },
      select: { expiresAt: true },
    });
    return token?.expiresAt ?? null;
  }
}
