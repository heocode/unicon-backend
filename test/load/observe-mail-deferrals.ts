import { isDeepStrictEqual } from 'node:util';

import type { AuthenticationChallengeDelivery } from '../../src/generated/prisma/client';
import { AuthenticationDeliveryRepository } from '../../src/auth/delivery/repositories/authentication-delivery.repository';
import { MailDeliveryRepository } from '../../src/mail/repositories/mail-delivery.repository';
import { PrismaService } from '../../src/prisma/prisma.service';
import type { DeferralObservations } from './concurrency-protocol';

export function observeMailDeferrals(
  prisma: PrismaService,
  auth: AuthenticationDeliveryRepository,
  notifications: MailDeliveryRepository,
) {
  const empty = (): DeferralObservations => ({
    transitions: 0,
    snapshots: 0,
    racedReads: 0,
    invalidSnapshots: 0,
    readErrors: 0,
  });
  const observed = { auth: empty(), notifications: empty() };
  const deferAuth = auth.deferUnstartedDelivery.bind(
    auth,
  ) as typeof auth.deferUnstartedDelivery;
  auth.deferUnstartedDelivery = async (claim, boundary) => {
    let before: AuthenticationChallengeDelivery | null = null;
    try {
      before = await prisma.authenticationChallengeDelivery.findUnique({
        where: { id: claim.id },
      });
    } catch {
      observed.auth.readErrors++;
    }
    // Never catch/substitute an enforcement failure, modify arguments or return
    // an invented outcome. Only the extra diagnostic reads are isolated.
    const result = await deferAuth(claim, boundary);
    if (result !== 'DEFERRED') return result;
    const counter = observed.auth;
    counter.transitions++;
    try {
      const after = await prisma.authenticationChallengeDelivery.findUnique({
        where: { id: claim.id },
      });
      if (!after) {
        counter.invalidSnapshots++;
        return result;
      }
      if (after.status !== 'PENDING' || after.processingLeaseId !== null) {
        counter.racedReads++;
        return result;
      }
      counter.snapshots++;
      const valid =
        before &&
        before.processingLeaseId === claim.leaseId &&
        before.attemptCount === 0 &&
        after.attemptCount === before.attemptCount &&
        !after.processingAttemptStarted &&
        after.processingLeaseExpiresAt === null &&
        isDeepStrictEqual(after.attemptedAt, before.attemptedAt) &&
        after.lastSafeFailureCode === before.lastSafeFailureCode &&
        after.idempotencyKey === before.idempotencyKey &&
        after.challengeId === before.challengeId &&
        after.recipientSnapshot === before.recipientSnapshot &&
        after.method === before.method &&
        after.origin === before.origin &&
        after.templateProtocolVersion === before.templateProtocolVersion &&
        isDeepStrictEqual(
          after.retentionExpiresAt,
          before.retentionExpiresAt,
        ) &&
        boundary !== undefined &&
        after.nextAttemptAt !== null &&
        BigInt(after.nextAttemptAt.getTime()) >= (boundary + 999n) / 1000n;
      if (!valid) counter.invalidSnapshots++;
    } catch {
      counter.readErrors++;
    }
    return result;
  };
  const deferNotification = notifications.defer.bind(
    notifications,
  ) as typeof notifications.defer;
  notifications.defer = async (claim, boundary) => {
    const result = await deferNotification(claim, boundary);
    if (result !== 'DEFERRED') return result;
    const counter = observed.notifications;
    counter.transitions++;
    try {
      const after = await prisma.notificationDelivery.findUnique({
        where: { id: claim.id },
      });
      if (!after) {
        counter.invalidSnapshots++;
        return result;
      }
      if (after.status !== 'PENDING' || after.mailLeaseId !== null) {
        counter.racedReads++;
        return result;
      }
      counter.snapshots++;
      const valid =
        claim.mailAttemptCount === 0 &&
        after.mailAttemptCount === claim.mailAttemptCount &&
        !after.mailAttemptStarted &&
        after.mailLeaseExpiresAt === null &&
        isDeepStrictEqual(after.attemptedAt, claim.attemptedAt) &&
        after.failureCode === claim.failureCode &&
        after.idempotencyKey === claim.idempotencyKey &&
        after.recipient === claim.recipient &&
        after.channel === claim.channel &&
        after.type === claim.type &&
        isDeepStrictEqual(after.mailPayload, claim.mailPayload) &&
        isDeepStrictEqual(after.mailIv, claim.mailIv) &&
        isDeepStrictEqual(after.mailTag, claim.mailTag) &&
        after.mailProtocol === claim.mailProtocol &&
        after.mailKeyVersion === claim.mailKeyVersion &&
        isDeepStrictEqual(after.mailQueuedAt, claim.mailQueuedAt) &&
        isDeepStrictEqual(after.mailExpiresAt, claim.mailExpiresAt) &&
        isDeepStrictEqual(after.retentionExpiresAt, claim.retentionExpiresAt) &&
        boundary !== undefined &&
        after.mailNextAttemptAt !== null &&
        BigInt(after.mailNextAttemptAt.getTime()) >= (boundary + 999n) / 1000n;
      if (!valid) counter.invalidSnapshots++;
    } catch {
      counter.readErrors++;
    }
    return result;
  };
  return observed;
}
