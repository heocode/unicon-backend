import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client';

import { AuthenticationChallengeTransitionConflictError } from '../errors/authentication-challenge-transition-conflict.error';
import type { ChallengeProofPersistenceData } from '../types/challenge-proof.type';

export type SignInChallengeCandidate = {
  id: string;
  expiresAt: Date;
  hasProof: boolean;
};

type OperationTimestampRow = { operationNow: Date };

@Injectable()
export class AuthenticationChallengeRequestRepository {
  async lockSignInSubject(
    transaction: Prisma.TransactionClient,
    key: string,
    normalizedIdentity: string,
  ): Promise<string> {
    // RC orphan cleanup/finalization can delete an empty row after ON CONFLICT
    // but before SELECT locks it. Repeat only this coordination step, bounded.
    for (let attempt = 0; attempt < 3; attempt++) {
      await transaction.$executeRaw`
      INSERT INTO "AuthenticationChallengeSubject" ("key", "normalizedIdentity", "purpose", "updatedAt")
      VALUES (${key}, ${normalizedIdentity}, 'SIGN_IN', clock_timestamp())
      ON CONFLICT ("normalizedIdentity", "purpose") DO NOTHING
    `;
      const [subject] = await transaction.$queryRaw<{ key: string }[]>`
      SELECT "key" FROM "AuthenticationChallengeSubject"
      WHERE "normalizedIdentity" = ${normalizedIdentity} AND "purpose" = 'SIGN_IN'
      FOR UPDATE
    `;
      if (subject) return subject.key;
    }
    throw new AuthenticationChallengeTransitionConflictError();
  }

  /** Include legacy subjects; identity/purpose is authoritative for resolution. */
  lockSignInCandidates(
    transaction: Prisma.TransactionClient,
    normalizedIdentity: string,
  ): Promise<SignInChallengeCandidate[]> {
    return transaction.$queryRaw<SignInChallengeCandidate[]>`
      SELECT "id", "expiresAt",
        ("encryptedProof" IS NOT NULL AND "proofEncryptionIv" IS NOT NULL
          AND "proofEncryptionTag" IS NOT NULL) AS "hasProof"
      FROM "AuthenticationChallenge"
      WHERE "normalizedIdentity" = ${normalizedIdentity} AND "purpose" = 'SIGN_IN'
        AND "identityType" = 'INSTITUTIONAL_EMAIL'
        AND "consumedAt" IS NULL AND "lockedAt" IS NULL
      ORDER BY "id" FOR UPDATE
    `;
  }

  createSignInChallenge(
    transaction: Prisma.TransactionClient,
    input: {
      id: string;
      subjectKey: string;
      normalizedIdentity: string;
      persistence: ChallengeProofPersistenceData;
      createdAt: Date;
      expiresAt: Date;
      retentionExpiresAt: Date;
    },
  ): Promise<{ id: string; expiresAt: Date }> {
    const { hashing, encryption } = input.persistence;
    return transaction.authenticationChallenge.create({
      data: {
        id: input.id,
        subjectKey: input.subjectKey,
        normalizedIdentity: input.normalizedIdentity,
        identityType: 'INSTITUTIONAL_EMAIL',
        purpose: 'SIGN_IN',
        ...hashing,
        ...encryption,
        otpHash: Uint8Array.from(hashing.otpHash),
        linkTokenHash: Uint8Array.from(hashing.linkTokenHash),
        encryptedProof: Uint8Array.from(encryption.encryptedProof),
        proofEncryptionIv: Uint8Array.from(encryption.proofEncryptionIv),
        proofEncryptionTag: Uint8Array.from(encryption.proofEncryptionTag),
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        expiresAt: input.expiresAt,
        retentionExpiresAt: input.retentionExpiresAt,
      },
      select: { id: true, expiresAt: true },
    });
  }

  async getOperationTimestamp(
    transaction: Prisma.TransactionClient,
  ): Promise<Date> {
    const rows = await transaction.$queryRaw<OperationTimestampRow[]>(
      Prisma.sql`SELECT clock_timestamp() AS "operationNow"`,
    );
    const operationNow = rows[0]?.operationNow;

    if (!operationNow) {
      throw new AuthenticationChallengeTransitionConflictError();
    }

    return operationNow;
  }
}
