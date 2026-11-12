import { Injectable } from '@nestjs/common';

import {
  Prisma,
  type MailProviderPressure,
} from '../../generated/prisma/client';

import { GcraAdmissionInfrastructureError } from '../../rate-limit/errors/gcra-admission-infrastructure.error';

@Injectable()
export class MailProviderPressureRepository {
  // Caller always acquires the fixed mail gate advisory lock first.
  async read(
    transaction: Prisma.TransactionClient,
  ): Promise<MailProviderPressure> {
    const [row] = await transaction.$queryRaw<MailProviderPressure[]>`
      SELECT * FROM "MailProviderPressure" WHERE "id"=1 FOR UPDATE
    `;
    if (
      !row ||
      row.retryNotBeforeMicros < 0n ||
      row.dailyNotBeforeMicros < 0n ||
      row.revision < 0n
    )
      throw new GcraAdmissionInfrastructureError('INVALID_STATE');
    return row;
  }

  async write(
    transaction: Prisma.TransactionClient,
    state: MailProviderPressure,
  ): Promise<void> {
    await transaction.mailProviderPressure.update({
      where: { id: 1 },
      data: {
        retryNotBeforeMicros: state.retryNotBeforeMicros,
        dailyNotBeforeMicros: state.dailyNotBeforeMicros,
        monthlyBlocked: state.monthlyBlocked,
        revision: { increment: 1 },
      },
    });
  }
}
