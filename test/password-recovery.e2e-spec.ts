import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password/services/password.service';
import { configureApp } from '../src/configure-app';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';

type Tokens = { accessToken: string; refreshToken: string };

describe('Password recovery with PostgreSQL (e2e)', () => {
  const email = 'recovery-e2e@my.centennialcollege.ca';
  const oldPassword = 'CurrentPassword1!';
  const newPassword = 'NewPassword2!';
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let passwordService: PasswordService;
  let resetToken: string;

  beforeAll(async () => {
    assertTestDatabase();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    passwordService = app.get(PasswordService);
    const mailService = app.get(MailService);
    jest.spyOn(mailService, 'sendNewSessionEmail').mockResolvedValue('session');
    jest
      .spyOn(mailService, 'sendSuspiciousActivityEmail')
      .mockResolvedValue('risk');
    jest
      .spyOn(mailService, 'sendPasswordResetRequestEmail')
      .mockImplementation(({ token }) => {
        resetToken = token;
        return Promise.resolve('reset-request');
      });
    jest
      .spyOn(mailService, 'sendPasswordResetCompletedEmail')
      .mockResolvedValue('reset-completed');
    jest
      .spyOn(mailService, 'sendAccountDeletionRequestedEmail')
      .mockResolvedValue('deletion-requested');
    jest
      .spyOn(mailService, 'sendAccountDeletionCancelledEmail')
      .mockResolvedValue('deletion-cancelled');
  });

  beforeEach(async () => {
    resetToken = '';
    await cleanDatabase();
    const university = await prisma.university.create({
      data: { name: 'Recovery E2E University' },
    });
    await prisma.user.create({
      data: {
        email,
        username: 'recovery-e2e-user',
        emailVerified: true,
        passwordHash: await passwordService.hash(oldPassword),
        universityId: university.id,
        status: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    if (prisma) await cleanDatabase();
    if (app) await app.close();
  });

  it('resets the password, consumes the token, and revokes every session', async () => {
    const first = await login(oldPassword, 'First device');
    const second = await login(oldPassword, 'Second device');

    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(202)
      .expect({
        message:
          'If an eligible account exists, password reset instructions will be sent.',
      });
    expect(resetToken).toHaveLength(64);

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .set('X-Device-Model', 'Recovery browser')
      .send({
        token: resetToken,
        newPassword,
        confirmNewPassword: newPassword,
      })
      .expect(200)
      .expect({
        message: 'Password reset successfully.',
        revokedSessionsCount: 2,
      });

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: oldPassword })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: newPassword })
      .expect(201);
    for (const tokens of [first, second]) {
      await request(app.getHttpServer())
        .get('/profile/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(401);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Authorization', `Bearer ${tokens.refreshToken}`)
        .expect(401);
    }

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({
        token: resetToken,
        newPassword: 'ThirdPassword3!',
        confirmNewPassword: 'ThirdPassword3!',
      })
      .expect(400)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'PASSWORD_RESET_TOKEN_INVALID' }),
      );

    const events = await prisma.securityEvent.findMany({
      where: {
        type: { in: ['PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED'] },
      },
    });
    expect(events).toHaveLength(2);
    expect(
      events.find(({ type }) => type === 'PASSWORD_RESET_COMPLETED')
        ?.affectedSessionCount,
    ).toBe(2);
  });

  it('does not reveal whether an eligible account exists', async () => {
    const expected = {
      message:
        'If an eligible account exists, password reset instructions will be sent.',
    };
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(202)
      .expect(expected);
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'unknown@my.centennialcollege.ca' })
      .expect(202)
      .expect(expected);
  });

  it('keeps old reset tokens invalid through deletion and cancellation', async () => {
    const session = await login(oldPassword, 'Current device');

    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(202);
    const oldResetToken = resetToken;
    expect(oldResetToken).toHaveLength(64);

    await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword: oldPassword })
      .expect(202);

    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(202);
    expect(resetToken).toBe(oldResetToken);
    expect(
      await prisma.passwordResetToken.count({
        where: { user: { email }, invalidatedAt: null },
      }),
    ).toBe(0);

    await expectResetTokenRejected(oldResetToken);

    const cancellation = await request(app.getHttpServer())
      .post('/account/deletion/cancel')
      .send({ email, currentPassword: oldPassword })
      .expect(200);
    expect(cancellation.body).toMatchObject({
      status: 'ACTIVE',
      deletionCancelled: true,
    });

    await expectResetTokenRejected(oldResetToken);

    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(202);
    expect(resetToken).toHaveLength(64);
    expect(resetToken).not.toBe(oldResetToken);

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({
        token: resetToken,
        newPassword,
        confirmNewPassword: newPassword,
      })
      .expect(200);
  });

  it('keeps password reset and deletion request mutually consistent under concurrency', async () => {
    const session = await login(oldPassword, 'Current device');

    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(202);

    const [resetResponse, deletionResponse] = await Promise.all([
      request(app.getHttpServer()).post('/auth/reset-password').send({
        token: resetToken,
        newPassword,
        confirmNewPassword: newPassword,
      }),
      request(app.getHttpServer())
        .post('/account/deletion')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ currentPassword: oldPassword }),
    ]);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { status: true },
    });

    if (deletionResponse.status === 202) {
      expect(resetResponse.status).toBe(400);
      expect(resetResponse.body).toMatchObject({
        code: 'PASSWORD_RESET_TOKEN_INVALID',
      });
      expect(user.status).toBe('DELETION_SCHEDULED');
      return;
    }

    expect(resetResponse.status).toBe(200);
    expect([401, 409]).toContain(deletionResponse.status);
    expect(user.status).toBe('ACTIVE');
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: newPassword })
      .expect(201);
  });

  it('returns a cooldown when the email request limit is exhausted', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email })
        .expect(202);
    }

    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(429)
      .expect('Retry-After', /\d+/)
      .expect(({ body }) => {
        const response = body as {
          code: string;
          message: string;
          details: { retryAfterSeconds: number };
        };
        expect(response).toMatchObject({
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many password reset requests. Please try again later.',
        });
        expect(response.details.retryAfterSeconds).toBeGreaterThan(0);
      });
  });

  async function login(password: string, deviceModel: string): Promise<Tokens> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Device-Model', deviceModel)
      .send({ email, password })
      .expect(201);
    return response.body as Tokens;
  }

  async function expectResetTokenRejected(token: string): Promise<void> {
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({
        token,
        newPassword,
        confirmNewPassword: newPassword,
      })
      .expect(400)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'PASSWORD_RESET_TOKEN_INVALID' }),
      );
  }

  async function cleanDatabase() {
    await prisma.accountDeletionCancellationRateLimit.deleteMany();
    await prisma.notificationDelivery.deleteMany();
    await prisma.securityEvent.deleteMany();
    await prisma.passwordResetToken.deleteMany();
    await prisma.passwordResetRateLimit.deleteMany();
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
    await prisma.allowedDomain.deleteMany();
    await prisma.university.deleteMany();
  }
});

function assertTestDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Refusing to use database "${databaseName}".`);
  }
}
