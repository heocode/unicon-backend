import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { Prisma } from '../../../generated/prisma/client';

@Injectable()
export class AuthenticationChallengeFinalizationRepository {
  /** Called inside account finalization under the account's User row lock. */
  async deleteForAccount(
    transaction: Prisma.TransactionClient,
    userId: string,
    normalizedIdentity: string,
  ): Promise<void> {
    // Establish the same absent-row serialization boundary as initial requests.
    await transaction.$executeRaw`
      INSERT INTO "AuthenticationChallengeSubject" ("key", "normalizedIdentity", "purpose", "updatedAt")
      VALUES (${randomUUID()}, ${normalizedIdentity}, 'SIGN_IN', clock_timestamp())
      ON CONFLICT ("normalizedIdentity", "purpose") DO NOTHING
    `;
    const target = Prisma.sql`(challenge."userId"=${userId} OR (
      challenge."userId" IS NULL AND challenge."normalizedIdentity"=${normalizedIdentity}
      AND challenge."purpose"='SIGN_IN' AND challenge."identityType"='INSTITUTIONAL_EMAIL'
    ))`;
    const subjects = await transaction.$queryRaw<{ key: string }[]>(Prisma.sql`
      SELECT subject."key" FROM "AuthenticationChallengeSubject" AS subject
      WHERE subject."normalizedIdentity"=${normalizedIdentity} OR EXISTS (
        SELECT 1 FROM "AuthenticationChallenge" AS challenge
        WHERE challenge."subjectKey"=subject."key" AND ${target}
      )
      ORDER BY subject."key" FOR UPDATE OF subject
    `);
    await transaction.$queryRaw(Prisma.sql`
      SELECT challenge."id" FROM "AuthenticationChallenge" AS challenge
      WHERE ${target} ORDER BY challenge."id" FOR UPDATE
    `);
    await transaction.$executeRaw(Prisma.sql`
      DELETE FROM "AuthenticationChallenge" AS challenge WHERE ${target}
    `);
    if (!subjects.length) return;
    // Fresh ownership/legacy-reference check; never cascade another user's work.
    await transaction.$executeRaw(Prisma.sql`
      DELETE FROM "AuthenticationChallengeSubject" AS subject
      WHERE subject."key" IN (${Prisma.join(subjects.map((subject) => subject.key))})
        AND subject."normalizedIdentity" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "AuthenticationChallenge" AS challenge
          WHERE challenge."subjectKey"=subject."key" OR (
            challenge."normalizedIdentity"=subject."normalizedIdentity"
            AND challenge."purpose"=subject."purpose"
          )
        )
    `);
  }
}
