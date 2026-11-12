import type { Prisma } from '../../../generated/prisma/client';

import { AuthenticationChallengeRequestRepository } from './authentication-challenge-request.repository';

describe('AuthenticationChallengeRequestRepository coordination retry (unit)', () => {
  it('recreates/relocks a subject removed between conflict resolution and row locking', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ key: 'new-subject' }]),
    };
    expect(
      await new AuthenticationChallengeRequestRepository().lockSignInSubject(
        tx as unknown as Prisma.TransactionClient,
        'new-subject',
        'student@example.edu',
      ),
    ).toBe('new-subject');
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
  it('bounds repeated confirmed missing rows to three coordination attempts', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    await expect(
      new AuthenticationChallengeRequestRepository().lockSignInSubject(
        tx as unknown as Prisma.TransactionClient,
        'subject',
        'student@example.edu',
      ),
    ).rejects.toThrow();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
  });
  it('propagates transaction errors for a whole-owner retry instead of retrying an aborted scope', async () => {
    const failure = new Error('Synthetic serialization abort.');
    const tx = {
      $executeRaw: jest.fn().mockRejectedValue(failure),
      $queryRaw: jest.fn(),
    };
    await expect(
      new AuthenticationChallengeRequestRepository().lockSignInSubject(
        tx as unknown as Prisma.TransactionClient,
        'subject',
        'student@example.edu',
      ),
    ).rejects.toBe(failure);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
