import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password/services/password.service';
import { configureApp } from '../src/configure-app';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

describe('Account password change with PostgreSQL (e2e)', () => {
  const email = 'account-e2e@my.centennialcollege.ca';
  const currentPassword = 'CurrentPassword1!';
  const newPassword = 'NewPassword2!';

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mailService: MailService;
  let passwordService: PasswordService;
  let sendPasswordChangedEmail: jest.SpiedFunction<
    MailService['sendPasswordChangedEmail']
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

    await cleanDatabase();

    const university = await prisma.university.create({
      data: { name: 'Account E2E University' },
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

  async function cleanDatabase(): Promise<void> {
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
