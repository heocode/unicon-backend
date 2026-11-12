import type { Prisma } from '../../../generated/prisma/client';

import { AuthenticationDeliveryBacklogRepository } from './authentication-delivery-backlog.repository';

describe('AuthenticationDeliveryBacklogRepository (unit)', () => {
  it('updates the singleton version before counting current outstanding rows and sampling DB time', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ outstanding: '3', now: '1234567890123456' }]);
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    expect(
      await new AuthenticationDeliveryBacklogRepository().lockAndCountInTransaction(
        tx,
      ),
    ).toEqual({ outstanding: 3n, operationNowMicros: 1234567890123456n });
    const calls = query.mock.calls as [TemplateStringsArray][];
    expect(calls[0][0].join('')).toContain(
      'UPDATE "AuthenticationDeliveryBacklogState"',
    );
    expect(calls[1][0].join('')).toContain("IN ('PENDING','PROCESSING')");
    expect(calls[1][0].join('')).toContain('clock_timestamp()');
  });
  it('fails closed on a missing coordination row without creating it or counting unprotected state', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await expect(
      new AuthenticationDeliveryBacklogRepository().lockAndCountInTransaction({
        $queryRaw: query,
      } as unknown as Prisma.TransactionClient),
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
