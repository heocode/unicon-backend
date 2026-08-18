import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { AccountDeletionFinalizationService } from '../src/account/services/account-deletion-finalization.service';
import { PasswordService } from '../src/auth/password/services/password.service';
import { configureApp } from '../src/configure-app';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  expectNoInternalFields,
  expectOnlyKeys,
  expectPublicError,
} from './public-contract.assertions';

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

type AccountDeletionResponse = {
  deletionScheduledAt: string;
};

type RateLimitResponse = {
  code: string;
  message: string;
  details: { retryAfterSeconds: number };
};

describe('Account password change with PostgreSQL (e2e)', () => {
  const email = 'account-e2e@my.centennialcollege.ca';
  const currentPassword = 'CurrentPassword1!';
  const newPassword = 'NewPassword2!';

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mailService: MailService;
  let passwordService: PasswordService;
  let finalizationService: AccountDeletionFinalizationService;
  let sendPasswordChangedEmail: jest.SpiedFunction<
    MailService['sendPasswordChangedEmail']
  >;
  let sendDeletionRequestedEmail: jest.SpiedFunction<
    MailService['sendAccountDeletionRequestedEmail']
  >;
  let sendDeletionCancelledEmail: jest.SpiedFunction<
    MailService['sendAccountDeletionCancelledEmail']
  >;
  let sendAccountDeletedEmail: jest.SpiedFunction<
    MailService['sendAccountDeletedEmail']
  >;

  beforeAll(async () => {
    assertTestDatabase();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    mailService = app.get(MailService);
    passwordService = app.get(PasswordService);
    finalizationService = app.get(AccountDeletionFinalizationService);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest
      .spyOn(mailService, 'sendNewSessionEmail')
      .mockResolvedValue('test-provider-message-id');
    jest
      .spyOn(mailService, 'sendSuspiciousActivityEmail')
      .mockResolvedValue('test-suspicious-provider-message-id');
    sendPasswordChangedEmail = jest
      .spyOn(mailService, 'sendPasswordChangedEmail')
      .mockResolvedValue('test-password-provider-message-id');
    sendDeletionRequestedEmail = jest
      .spyOn(mailService, 'sendAccountDeletionRequestedEmail')
      .mockResolvedValue('test-deletion-request-provider-message-id');
    sendDeletionCancelledEmail = jest
      .spyOn(mailService, 'sendAccountDeletionCancelledEmail')
      .mockResolvedValue('test-deletion-cancel-provider-message-id');
    sendAccountDeletedEmail = jest
      .spyOn(mailService, 'sendAccountDeletedEmail')
      .mockResolvedValue('test-account-deleted-provider-message-id');
    jest.spyOn(mailService, 'sendVerificationEmail').mockResolvedValue();

    await cleanDatabase();

    const university = await prisma.university.create({
      data: { name: 'Account E2E University' },
    });
    await prisma.allowedDomain.create({
      data: {
        domain: 'my.centennialcollege.ca',
        universityId: university.id,
      },
    });

    await prisma.user.create({
      data: {
        email,
        username: 'account-e2e-user',
        emailVerified: true,
        passwordHash: await passwordService.hash(currentPassword),
        universityId: university.id,
        status: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await cleanDatabase();
    }

    if (app) {
      await app.close();
    }
  });

  it('changes the password, preserves the caller, and revokes other sessions', async () => {
    const currentSession = await login(currentPassword, 'Current device');
    const otherSession = await login(currentPassword, 'Other device');

    await request(app.getHttpServer())
      .patch('/account/password')
      .set('Authorization', `Bearer ${currentSession.accessToken}`)
      .send({
        currentPassword,
        newPassword,
        confirmNewPassword: newPassword,
      })
      .expect(200)
      .expect({
        message: 'Password changed successfully.',
        revokedSessionsCount: 1,
      });

    await request(app.getHttpServer())
      .get('/profile/me')
      .set('Authorization', `Bearer ${currentSession.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get('/profile/me')
      .set('Authorization', `Bearer ${otherSession.accessToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Authorization', `Bearer ${otherSession.refreshToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: currentPassword })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: newPassword })
      .expect(201);

    const event = await prisma.securityEvent.findFirst({
      where: { type: 'PASSWORD_CHANGED' },
      select: {
        id: true,
        userId: true,
        actorSessionId: true,
        affectedSessionCount: true,
      },
    });

    expect(event).not.toBeNull();
    expect(typeof event?.userId).toBe('string');
    expect(typeof event?.actorSessionId).toBe('string');
    expect(event?.affectedSessionCount).toBe(1);

    const delivery = await prisma.notificationDelivery.findFirst({
      where: { type: 'PASSWORD_CHANGED' },
      select: {
        status: true,
        userId: true,
        sessionId: true,
        providerMessageId: true,
        idempotencyKey: true,
      },
    });

    expect(delivery).toMatchObject({
      status: 'SENT',
      userId: event?.userId,
      sessionId: event?.actorSessionId,
      providerMessageId: 'test-password-provider-message-id',
      idempotencyKey: `PASSWORD_CHANGED:${event?.id}`,
    });
    expect(sendPasswordChangedEmail).toHaveBeenCalledTimes(1);
  });

  it('creates distinct notifications for repeated changes in one session', async () => {
    const session = await login(currentPassword, 'Current device');
    const thirdPassword = 'ThirdPassword3!';

    await request(app.getHttpServer())
      .patch('/account/password')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({
        currentPassword,
        newPassword,
        confirmNewPassword: newPassword,
      })
      .expect(200);

    await request(app.getHttpServer())
      .patch('/account/password')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({
        currentPassword: newPassword,
        newPassword: thirdPassword,
        confirmNewPassword: thirdPassword,
      })
      .expect(200);

    const deliveries = await prisma.notificationDelivery.findMany({
      where: { type: 'PASSWORD_CHANGED' },
      select: { idempotencyKey: true, sessionId: true, status: true },
    });

    expect(deliveries).toHaveLength(2);
    expect(
      new Set(deliveries.map(({ idempotencyKey }) => idempotencyKey)).size,
    ).toBe(2);
    expect(
      deliveries.every(({ sessionId }) => typeof sessionId === 'string'),
    ).toBe(true);
    expect(deliveries.every(({ status }) => status === 'SENT')).toBe(true);
    expect(sendPasswordChangedEmail).toHaveBeenCalledTimes(2);
  });

  it('schedules account deletion and immediately revokes every session', async () => {
    const currentSession = await login(currentPassword, 'Current device');
    const otherSession = await login(currentPassword, 'Other device');

    const response = await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Authorization', `Bearer ${currentSession.accessToken}`)
      .send({ currentPassword })
      .expect(202);
    const deletionResponse = response.body as AccountDeletionResponse;

    expectOnlyKeys(response.body, [
      'status',
      'deletionScheduledAt',
      'gracePeriodSeconds',
    ]);
    expectNoInternalFields(response.body);
    expect(response.body).toMatchObject({
      status: 'DELETION_SCHEDULED',
      gracePeriodSeconds: 2_592_000,
    });
    expect(
      new Date(deletionResponse.deletionScheduledAt).getTime(),
    ).toBeGreaterThan(Date.now());

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: {
        status: true,
        deletionRequestedAt: true,
        deletionScheduledAt: true,
      },
    });
    expect(user.status).toBe('DELETION_SCHEDULED');
    expect(user.deletionRequestedAt).not.toBeNull();
    expect(user.deletionScheduledAt?.toISOString()).toBe(
      deletionResponse.deletionScheduledAt,
    );

    const sessions = await prisma.session.findMany({
      where: { userId: await findUserId() },
      select: { revokedAt: true },
    });
    expect(sessions).toHaveLength(2);
    expect(sessions.every(({ revokedAt }) => revokedAt !== null)).toBe(true);

    for (const tokens of [currentSession, otherSession]) {
      await request(app.getHttpServer())
        .get('/profile/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(401);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Authorization', `Bearer ${tokens.refreshToken}`)
        .expect(401);
    }

    const event = await prisma.securityEvent.findFirst({
      where: { type: 'ACCOUNT_DELETION_REQUESTED' },
      select: {
        userId: true,
        actorSessionId: true,
        affectedSessionCount: true,
      },
    });
    expect(event).toMatchObject({
      userId: await findUserId(),
      affectedSessionCount: 2,
    });
    expect(event?.actorSessionId).not.toBeNull();

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'WrongPassword1!' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: currentPassword })
      .expect(403)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          code: 'ACCOUNT_DELETION_SCHEDULED',
          details: {
            deletionScheduledAt: deletionResponse.deletionScheduledAt,
            canCancel: true,
          },
        }),
      );
    expect(
      await prisma.session.count({ where: { userId: await findUserId() } }),
    ).toBe(2);

    await request(app.getHttpServer())
      .post('/account/deletion/cancel')
      .send({ email, currentPassword: 'WrongPassword1!' })
      .expect(401)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'INVALID_CREDENTIALS' }),
      );

    const cancellation = await request(app.getHttpServer())
      .post('/account/deletion/cancel')
      .set('X-Device-Model', 'Cancellation device')
      .set('X-Platform', 'WEB')
      .send({ email: `  ${email.toUpperCase()}  `, currentPassword })
      .expect(200);
    const cancellationTokens = cancellation.body as AuthTokens & {
      status: string;
      deletionCancelled: boolean;
    };
    expectOnlyKeys(cancellation.body, [
      'status',
      'deletionCancelled',
      'accessToken',
      'refreshToken',
    ]);
    expectNoInternalFields(cancellation.body);
    expect(cancellationTokens).toMatchObject({
      status: 'ACTIVE',
      deletionCancelled: true,
    });
    expect(cancellationTokens.accessToken).toEqual(expect.any(String));
    expect(cancellationTokens.refreshToken).toEqual(expect.any(String));

    await request(app.getHttpServer())
      .get('/profile/me')
      .set('Authorization', `Bearer ${cancellationTokens.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Authorization', `Bearer ${cancellationTokens.refreshToken}`)
      .expect(201);

    for (const tokens of [currentSession, otherSession]) {
      await request(app.getHttpServer())
        .get('/profile/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(401);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Authorization', `Bearer ${tokens.refreshToken}`)
        .expect(401);
    }

    const restoredUser = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: {
        status: true,
        deletionRequestedAt: true,
        deletionScheduledAt: true,
        sessions: { select: { revokedAt: true } },
      },
    });
    expect(restoredUser).toMatchObject({
      status: 'ACTIVE',
      deletionRequestedAt: null,
      deletionScheduledAt: null,
    });
    expect(
      restoredUser.sessions.filter(({ revokedAt }) => revokedAt === null),
    ).toHaveLength(1);
    expect(
      restoredUser.sessions.filter(({ revokedAt }) => revokedAt !== null),
    ).toHaveLength(2);

    expect(
      await prisma.securityEvent.count({
        where: { type: 'ACCOUNT_DELETION_CANCELLED' },
      }),
    ).toBe(1);

    const deletionDeliveries = await prisma.notificationDelivery.findMany({
      where: {
        type: {
          in: ['ACCOUNT_DELETION_REQUESTED', 'ACCOUNT_DELETION_CANCELLED'],
        },
      },
      select: { type: true, status: true, idempotencyKey: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(deletionDeliveries).toHaveLength(2);
    expect(deletionDeliveries.map(({ type }) => type)).toEqual([
      'ACCOUNT_DELETION_REQUESTED',
      'ACCOUNT_DELETION_CANCELLED',
    ]);
    expect(deletionDeliveries.every(({ status }) => status === 'SENT')).toBe(
      true,
    );
    expect(
      deletionDeliveries.every(({ idempotencyKey }) =>
        idempotencyKey?.includes('ACCOUNT_DELETION_'),
      ),
    ).toBe(true);
    expect(sendDeletionRequestedEmail).toHaveBeenCalledTimes(1);
    expect(sendDeletionCancelledEmail).toHaveBeenCalledTimes(1);

    await request(app.getHttpServer())
      .post('/account/deletion/cancel')
      .send({ email, currentPassword })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          code: 'ACCOUNT_DELETION_ALREADY_CANCELLED',
        }),
      );
  });

  it('allows only one concurrent cancellation to create a session', async () => {
    const session = await login(currentPassword, 'Current device');

    await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword })
      .expect(202);

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/account/deletion/cancel')
        .send({ email, currentPassword }),
      request(app.getHttpServer())
        .post('/account/deletion/cancel')
        .send({ email, currentPassword }),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(responses.find(({ status }) => status === 409)?.body).toMatchObject({
      code: 'ACCOUNT_DELETION_ALREADY_CANCELLED',
    });

    const userId = await findUserId();
    expect(
      await prisma.session.count({
        where: {
          userId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
    ).toBe(1);
    expect(
      await prisma.securityEvent.count({
        where: { userId, type: 'ACCOUNT_DELETION_CANCELLED' },
      }),
    ).toBe(1);
  });

  it('keeps deletion scheduled when its confirmation email fails', async () => {
    sendDeletionRequestedEmail.mockRejectedValue(
      new Error('Provider unavailable.'),
    );
    const session = await login(currentPassword, 'Deletion device');

    await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword })
      .expect(202);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { status: true },
    });
    expect(user.status).toBe('DELETION_SCHEDULED');

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { type: 'ACCOUNT_DELETION_REQUESTED' },
      select: { status: true, failureCode: true },
    });
    expect(delivery).toEqual({
      status: 'FAILED',
      failureCode: 'EMAIL_DELIVERY_FAILED',
    });
  });

  it('finalizes an expired account, retains audit, and releases its email', async () => {
    const session = await login(currentPassword, 'Deletion device');
    const userId = await findUserId();
    const originalUser = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    await prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: 'finalization-reset-token-hash',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword })
      .expect(202);
    const finalizationTime = new Date();
    await prisma.user.update({
      where: { id: userId },
      data: { deletionScheduledAt: finalizationTime },
    });

    await expect(
      finalizationService.finalizeBatch(finalizationTime),
    ).resolves.toBe(1);

    const tombstone = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        emailVerified: true,
        passwordHash: true,
        role: true,
        status: true,
        deletedAt: true,
        deletionRequestedAt: true,
        deletionScheduledAt: true,
        sessions: true,
        passwordResetTokens: true,
      },
    });
    expect(tombstone).toMatchObject({
      id: userId,
      email: `deleted+${userId}@deleted.invalid`,
      username: `deleted_${userId}`,
      emailVerified: false,
      role: 'MEMBER',
      status: 'DELETED',
      deletedAt: finalizationTime,
      deletionRequestedAt: null,
      deletionScheduledAt: null,
      sessions: [],
      passwordResetTokens: [],
    });
    expect(tombstone.passwordHash).not.toBe(originalUser.passwordHash);

    expect(
      await prisma.securityEvent.count({ where: { userId } }),
    ).toBeGreaterThanOrEqual(2);
    expect(
      await prisma.securityEvent.count({
        where: {
          userId,
          type: 'ACCOUNT_DELETED',
          reason: 'GRACE_PERIOD_EXPIRED',
        },
      }),
    ).toBe(1);

    const completionDelivery =
      await prisma.notificationDelivery.findFirstOrThrow({
        where: { userId, type: 'ACCOUNT_DELETED' },
        select: { recipient: true, status: true, idempotencyKey: true },
      });
    expect(completionDelivery).toMatchObject({
      recipient: email,
      status: 'SENT',
    });
    expect(completionDelivery.idempotencyKey).toMatch(/^ACCOUNT_DELETED:/);
    expect(sendAccountDeletedEmail).toHaveBeenCalledTimes(1);

    await request(app.getHttpServer())
      .get('/profile/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Authorization', `Bearer ${session.refreshToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email,
        password: 'RegisteredAgain1!',
        confirmedPassword: 'RegisteredAgain1!',
      })
      .expect(201);
    const replacement = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, status: true },
    });
    expect(replacement).toMatchObject({ status: 'PENDING' });
    expect(replacement.id).not.toBe(userId);
  });

  it('allows concurrent finalizers to finalize an account only once', async () => {
    const session = await login(currentPassword, 'Deletion device');
    await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword })
      .expect(202);
    const finalizationTime = new Date();
    await prisma.user.update({
      where: { email },
      data: { deletionScheduledAt: finalizationTime },
    });

    const results = await Promise.all([
      finalizationService.finalizeBatch(finalizationTime),
      finalizationService.finalizeBatch(finalizationTime),
    ]);
    expect(results.sort()).toEqual([0, 1]);
    expect(
      await prisma.securityEvent.count({ where: { type: 'ACCOUNT_DELETED' } }),
    ).toBe(1);
    expect(
      await prisma.notificationDelivery.count({
        where: { type: 'ACCOUNT_DELETED' },
      }),
    ).toBe(1);
    expect(sendAccountDeletedEmail).toHaveBeenCalledTimes(1);
  });

  it('keeps cancellation and finalization as a single-winner transition', async () => {
    const session = await login(currentPassword, 'Deletion device');
    const scheduled = await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword })
      .expect(202);
    const deletionResponse = scheduled.body as AccountDeletionResponse;
    const deadline = new Date(deletionResponse.deletionScheduledAt);

    const [cancellation, finalized] = await Promise.all([
      request(app.getHttpServer())
        .post('/account/deletion/cancel')
        .send({ email, currentPassword }),
      finalizationService.finalizeBatch(deadline),
    ]);

    const terminalUser = await prisma.user.findFirstOrThrow({
      where: {
        OR: [
          { email },
          {
            email: {
              startsWith: 'deleted+',
              endsWith: '@deleted.invalid',
            },
          },
        ],
      },
      select: { status: true },
    });

    if (cancellation.status === 200) {
      expect(finalized).toBe(0);
      expect(terminalUser.status).toBe('ACTIVE');
    } else {
      expect([401, 409]).toContain(cancellation.status);
      expect(finalized).toBe(1);
      expect(terminalUser.status).toBe('DELETED');
    }

    expect(
      await prisma.securityEvent.count({ where: { type: 'ACCOUNT_DELETED' } }),
    ).toBe(finalized);
    expect(
      await prisma.securityEvent.count({
        where: { type: 'ACCOUNT_DELETION_CANCELLED' },
      }),
    ).toBe(cancellation.status === 200 ? 1 : 0);
  });

  it('rate-limits cancellation by normalized email without storing raw PII', async () => {
    const activeSession = await login(currentPassword, 'Deletion device');
    await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Authorization', `Bearer ${activeSession.accessToken}`)
      .send({ currentPassword })
      .expect(202);

    for (let attempt = 0; attempt < 5; attempt++) {
      await request(app.getHttpServer())
        .post('/account/deletion/cancel')
        .send({
          email: `  ${email.toUpperCase()}  `,
          currentPassword: 'WrongPassword1!',
        })
        .expect(401);
    }

    const limited = await request(app.getHttpServer())
      .post('/account/deletion/cancel')
      .send({ email, currentPassword })
      .expect(429);
    const limitedBody = limited.body as RateLimitResponse;

    expect(limited.headers['retry-after']).toEqual(expect.any(String));
    expectPublicError(limited.body, 'RATE_LIMIT_EXCEEDED');
    expectOnlyKeys(limitedBody.details, ['retryAfterSeconds']);
    expect(limitedBody).toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
      message:
        'Too many account deletion cancellation attempts. Please try again later.',
    });
    expect(limitedBody.details.retryAfterSeconds).toBeGreaterThan(0);

    const buckets =
      await prisma.accountDeletionCancellationRateLimit.findMany();
    expect(buckets).toHaveLength(2);
    expect(buckets.map((bucket) => bucket.key)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^email:[a-f0-9]{64}$/),
        expect.stringMatching(/^ip:[a-f0-9]{64}$/),
      ]),
    );
    expect(JSON.stringify(buckets)).not.toContain(email);
  });

  it('rejects login and cancellation after the deletion deadline', async () => {
    const session = await login(currentPassword, 'Current device');

    await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword })
      .expect(202);

    const expiredDeadline = new Date(Date.now() - 1_000);
    await prisma.user.update({
      where: { email },
      data: { deletionScheduledAt: expiredDeadline },
    });

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: currentPassword })
      .expect(403)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          code: 'ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED',
          details: {
            deletionScheduledAt: expiredDeadline.toISOString(),
            canCancel: false,
          },
        }),
      );

    await request(app.getHttpServer())
      .post('/account/deletion/cancel')
      .send({ email, currentPassword })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          code: 'ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED',
        }),
      );

    expect(
      await prisma.session.count({
        where: {
          userId: await findUserId(),
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
    ).toBe(0);
  });

  it('enforces authorization, DTO validation, and password verification', async () => {
    await request(app.getHttpServer())
      .patch('/account/password')
      .send({
        currentPassword,
        newPassword,
        confirmNewPassword: newPassword,
      })
      .expect(401);

    const session = await login(currentPassword, 'Current device');

    await request(app.getHttpServer())
      .patch('/account/password')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({
        currentPassword,
        newPassword: 'weak',
        confirmNewPassword: 'weak',
      })
      .expect(400);

    await request(app.getHttpServer())
      .patch('/account/password')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({
        currentPassword: 'WrongPassword1!',
        newPassword,
        confirmNewPassword: newPassword,
      })
      .expect(401)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'CURRENT_PASSWORD_INVALID' });
      });

    await request(app.getHttpServer())
      .patch('/account/password')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({
        currentPassword,
        newPassword,
        confirmNewPassword: 'DifferentPassword3!',
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'PASSWORDS_DO_NOT_MATCH' });
      });
  });

  async function login(
    password: string,
    deviceModel: string,
  ): Promise<AuthTokens> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Device-Model', deviceModel)
      .send({ email, password })
      .expect(201);

    return response.body as AuthTokens;
  }

  async function findUserId(): Promise<string> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });

    return user.id;
  }

  async function cleanDatabase(): Promise<void> {
    await prisma.accountDeletionCancellationRateLimit.deleteMany();
    await prisma.notificationDelivery.deleteMany();
    await prisma.securityEvent.deleteMany();
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
    await prisma.allowedDomain.deleteMany();
    await prisma.university.deleteMany();
  }
});

function assertTestDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for database-backed e2e tests.');
  }

  const databaseName = new URL(databaseUrl).pathname.slice(1);

  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run database-backed e2e tests against database "${databaseName}".`,
    );
  }
}
