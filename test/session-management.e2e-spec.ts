import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PasswordService } from '../src/auth/password/services/password.service';
import { SecureTokenService } from '../src/auth/services/secure-token.service';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

type SessionListItem = {
  id: string;
  current: boolean;
  sessionName: string | null;
  device: {
    model: string | null;
  };
};

type SessionsResponse = {
  sessionManagement: {
    canManageSessions: boolean;
    managementAvailableAt: string | null;
  };
  sessions: SessionListItem[];
};

describe('Session management with PostgreSQL (e2e)', () => {
  const email = 'session-e2e@my.centennialcollege.ca';
  const password = 'Password1!';

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mailService: MailService;
  let secureTokenService: SecureTokenService;
  let passwordHash: string;

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
    secureTokenService = app.get(SecureTokenService);
    passwordHash = await app.get(PasswordService).hash(password);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest
      .spyOn(mailService, 'sendNewSessionEmail')
      .mockResolvedValue('test-provider-message-id');
    jest
      .spyOn(mailService, 'sendSuspiciousActivityEmail')
      .mockResolvedValue('test-suspicious-provider-message-id');
    await prisma.notificationDelivery.deleteMany();
    await prisma.securityEvent.deleteMany();
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
    await prisma.allowedDomain.deleteMany();
    await prisma.university.deleteMany();

    const university = await prisma.university.create({
      data: {
        name: 'Session E2E University',
      },
    });

    await prisma.user.create({
      data: {
        email,
        username: 'session-e2e-user',
        emailVerified: true,
        passwordHash,
        universityId: university.id,
        status: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.notificationDelivery.deleteMany();
      await prisma.securityEvent.deleteMany();
      await prisma.session.deleteMany();
      await prisma.user.deleteMany();
      await prisma.allowedDomain.deleteMany();
      await prisma.university.deleteMany();
    }

    if (app) {
      await app.close();
    }
  });

  it('enforces cooldown, rename, selected revoke, and revoke-others through HTTP', async () => {
    const sessionA = await login('Test MacBook A', 'WEB');
    const sessionsFromA = await getSessions(sessionA.accessToken);
    const sessionAId = currentSessionId(sessionsFromA);

    await prisma.session.update({
      where: { id: sessionAId },
      data: {
        createdAt: new Date(Date.now() - 86_401_000),
      },
    });

    const sessionB = await login('Test iPhone B', 'IOS');
    const sessionsFromB = await getSessions(sessionB.accessToken);
    const sessionBId = currentSessionId(sessionsFromB);

    expect(sessionsFromB.sessionManagement.canManageSessions).toBe(false);
    expect(
      sessionsFromB.sessionManagement.managementAvailableAt,
    ).not.toBeNull();

    await request(app.getHttpServer())
      .patch(`/auth/sessions/${sessionBId}`)
      .set('Authorization', `Bearer ${sessionB.accessToken}`)
      .send({ sessionName: 'My iPhone' })
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'SESSION_TOO_FRESH' });
      });

    await request(app.getHttpServer())
      .delete(`/auth/sessions/${sessionAId}`)
      .set('Authorization', `Bearer ${sessionB.accessToken}`)
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'SESSION_TOO_FRESH' });
      });

    const matureSessionsFromA = await getSessions(sessionA.accessToken);
    expect(matureSessionsFromA.sessionManagement).toEqual({
      canManageSessions: true,
      managementAvailableAt: null,
    });

    await request(app.getHttpServer())
      .patch(`/auth/sessions/${sessionBId}`)
      .set('Authorization', `Bearer ${sessionA.accessToken}`)
      .send({ sessionName: 'Test phone' })
      .expect(200)
      .expect({ id: sessionBId, sessionName: 'Test phone' });

    await request(app.getHttpServer())
      .patch(`/auth/sessions/${sessionBId}`)
      .set('Authorization', `Bearer ${sessionA.accessToken}`)
      .send({ sessionName: null })
      .expect(200)
      .expect({ id: sessionBId, sessionName: null });

    await request(app.getHttpServer())
      .delete(`/auth/sessions/${sessionBId}`)
      .set('Authorization', `Bearer ${sessionA.accessToken}`)
      .expect(204);

    await request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${sessionB.accessToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Authorization', `Bearer ${sessionB.refreshToken}`)
      .expect(401);

    const sessionC = await login('Test Android C', 'ANDROID');
    const sessionD = await login('Test Browser D', 'WEB');

    await request(app.getHttpServer())
      .delete('/auth/sessions/others')
      .set('Authorization', `Bearer ${sessionA.accessToken}`)
      .expect(200)
      .expect({ revokedSessionsCount: 2 });

    const remainingSessions = await getSessions(sessionA.accessToken);
    expect(remainingSessions.sessions).toHaveLength(1);
    expect(currentSessionId(remainingSessions)).toBe(sessionAId);

    await request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${sessionC.accessToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${sessionD.accessToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .delete('/auth/sessions/others')
      .set('Authorization', `Bearer ${sessionA.accessToken}`)
      .expect(200)
      .expect({ revokedSessionsCount: 0 });

    expect(
      await prisma.securityEvent.count({
        where: { type: 'SESSION_REVOKED' },
      }),
    ).toBe(1);
    expect(
      await prisma.securityEvent.findMany({
        where: { type: 'OTHER_SESSIONS_REVOKED' },
        select: { affectedSessionCount: true },
        orderBy: { occurredAt: 'asc' },
      }),
    ).toEqual([{ affectedSessionCount: 2 }, { affectedSessionCount: 0 }]);
  });

  it('records login outcomes without storing submitted credentials', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Device-Model', 'Unknown login device')
      .set('X-Platform', 'WEB')
      .send({ email: 'unknown@my.centennialcollege.ca', password: 'Wrong1!' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Device-Model', 'Known login device')
      .set('X-Platform', 'WEB')
      .send({ email, password: 'Wrong1!' })
      .expect(401);

    const failedEvents = await prisma.securityEvent.findMany({
      where: { type: 'LOGIN_FAILED' },
      select: {
        reason: true,
        userId: true,
        deviceModel: true,
      },
      orderBy: { occurredAt: 'asc' },
    });

    expect(failedEvents).toHaveLength(2);
    const unknownLoginEvent = failedEvents.find(
      ({ deviceModel }) => deviceModel === 'Unknown login device',
    );
    const knownLoginEvent = failedEvents.find(
      ({ deviceModel }) => deviceModel === 'Known login device',
    );

    expect(unknownLoginEvent).toEqual({
      reason: 'INVALID_CREDENTIALS',
      userId: null,
      deviceModel: 'Unknown login device',
    });
    expect(knownLoginEvent).toMatchObject({
      reason: 'INVALID_CREDENTIALS',
      deviceModel: 'Known login device',
    });
    expect(knownLoginEvent?.userId).not.toBeNull();

    const tokens = await login('Successful login device', 'IOS');
    const sessionId = currentSessionId(await getSessions(tokens.accessToken));
    const successfulEvents = await prisma.securityEvent.findMany({
      where: { type: { in: ['LOGIN_SUCCEEDED', 'SESSION_CREATED'] } },
      select: {
        type: true,
        actorSessionId: true,
        subjectSessionId: true,
      },
    });

    expect(successfulEvents).toEqual(
      expect.arrayContaining([
        {
          type: 'LOGIN_SUCCEEDED',
          actorSessionId: null,
          subjectSessionId: null,
        },
        {
          type: 'SESSION_CREATED',
          actorSessionId: sessionId,
          subjectSessionId: sessionId,
        },
      ]),
    );

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(201);

    await expect(
      prisma.securityEvent.findFirstOrThrow({
        where: {
          type: 'SESSION_REVOKED',
          reason: 'LOGOUT',
          subjectSessionId: sessionId,
        },
        select: { actorSessionId: true },
      }),
    ).resolves.toEqual({ actorSessionId: sessionId });

    await expect(
      prisma.notificationDelivery.findFirstOrThrow({
        where: { sessionId, type: 'NEW_SESSION', channel: 'EMAIL' },
        select: {
          status: true,
          providerMessageId: true,
          failureCode: true,
        },
      }),
    ).resolves.toEqual({
      status: 'SENT',
      providerMessageId: 'test-provider-message-id',
      failureCode: null,
    });
  });

  it('keeps login successful when the notification email fails', async () => {
    jest
      .spyOn(mailService, 'sendNewSessionEmail')
      .mockRejectedValueOnce(new Error('Provider unavailable.'));

    const tokens = await login('Delivery failure device', 'WEB');
    await getSessions(tokens.accessToken);

    await expect(
      prisma.notificationDelivery.findFirstOrThrow({
        where: { type: 'NEW_SESSION', channel: 'EMAIL' },
        select: { status: true, failureCode: true },
      }),
    ).resolves.toEqual({
      status: 'FAILED',
      failureCode: 'EMAIL_DELIVERY_FAILED',
    });
  });

  it('sends the same notification after verification creates the first session', async () => {
    const verificationToken = 'v'.repeat(64);
    await prisma.user.update({
      where: { email },
      data: {
        status: 'PENDING',
        emailVerified: false,
        hashedVerificationToken: secureTokenService.hash(verificationToken),
        verificationTokenExpires: new Date(Date.now() + 60_000),
      },
    });

    await request(app.getHttpServer())
      .post('/auth/verify-email')
      .set('X-Device-Model', 'Verified device')
      .set('X-Platform', 'IOS')
      .send({ token: verificationToken })
      .expect(201);

    await expect(
      prisma.notificationDelivery.findFirstOrThrow({
        where: { type: 'NEW_SESSION', channel: 'EMAIL' },
        select: { status: true, recipient: true },
      }),
    ).resolves.toEqual({ status: 'SENT', recipient: email });
  });

  it('records explainable risk levels without blocking session creation', async () => {
    await login('Known device', 'IOS');
    const lowRiskTokens = await login('New device', 'ANDROID');
    await getSessions(lowRiskTokens.accessToken);

    await expect(
      prisma.securityEvent.findFirstOrThrow({
        where: {
          type: 'SESSION_CREATED',
          deviceModel: 'New device',
        },
        select: { riskLevel: true, riskSignals: true },
      }),
    ).resolves.toEqual({
      riskLevel: 'LOW',
      riskSignals: ['NEW_DEVICE'],
    });

    const mediumRiskTokens = await login('Third device', 'WEB');
    await getSessions(mediumRiskTokens.accessToken);

    const suspiciousEvent = await prisma.securityEvent.findFirstOrThrow({
      where: {
        type: 'SUSPICIOUS_ACTIVITY_DETECTED',
        deviceModel: 'Third device',
      },
      select: { riskLevel: true, riskSignals: true },
    });
    expect(suspiciousEvent.riskLevel).toBe('MEDIUM');
    expect(suspiciousEvent.riskSignals).toEqual([
      'NEW_DEVICE',
      'MANY_NEW_SESSIONS',
    ]);
  });

  it('detects excessive login failures on a later successful login', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Device-Model', 'Credential pressure device')
        .set('X-Platform', 'WEB')
        .send({ email, password: 'WrongPassword1!' })
        .expect(401);
    }

    const tokens = await login('Credential pressure device', 'WEB');
    await getSessions(tokens.accessToken);

    await expect(
      prisma.securityEvent.findFirstOrThrow({
        where: { type: 'SUSPICIOUS_ACTIVITY_DETECTED' },
        select: { riskLevel: true, riskSignals: true },
      }),
    ).resolves.toEqual({
      riskLevel: 'MEDIUM',
      riskSignals: ['EXCESSIVE_LOGIN_FAILURES'],
    });
  });

  it('records refresh-token reuse as high risk without blocking the account', async () => {
    const tokens = await login('Refresh reuse device', 'WEB');

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Authorization', `Bearer ${tokens.refreshToken}`)
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Authorization', `Bearer ${tokens.refreshToken}`)
      .expect(401);

    await getSessions(tokens.accessToken);

    await expect(
      prisma.securityEvent.findFirstOrThrow({
        where: {
          type: 'SUSPICIOUS_ACTIVITY_DETECTED',
          riskSignals: { has: 'REFRESH_TOKEN_REUSE' },
        },
        select: { riskLevel: true },
      }),
    ).resolves.toEqual({ riskLevel: 'HIGH' });
    await expect(
      prisma.notificationDelivery.findFirstOrThrow({
        where: { type: 'SUSPICIOUS_ACTIVITY', channel: 'EMAIL' },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'SENT' });
  });

  it('rejects the eleventh session without revoking existing sessions', async () => {
    const sessions: AuthTokens[] = [];

    for (let index = 0; index < 10; index++) {
      sessions.push(await login(`Limit device ${index + 1}`, 'WEB'));
    }

    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Device-Model', 'Limit device 11')
      .set('X-Platform', 'WEB')
      .send({ email, password })
      .expect(409)
      .expect({
        code: 'SESSION_LIMIT_REACHED',
        message: 'The active session limit has been reached.',
        activeSessionLimit: 10,
      });

    expect(await activeSessionCount()).toBe(10);
    expect(
      await prisma.session.count({ where: { revokedAt: { not: null } } }),
    ).toBe(0);
    expect(
      await prisma.securityEvent.count({
        where: { type: 'SESSION_CREATION_FAILED' },
      }),
    ).toBe(1);

    const sessionList = await getSessions(sessions[0].accessToken);
    const currentId = currentSessionId(sessionList);
    const target = sessionList.sessions.find(({ current }) => !current);

    if (!target) {
      throw new Error('No other session was available to revoke.');
    }

    await prisma.session.update({
      where: { id: currentId },
      data: { createdAt: new Date(Date.now() - 86_401_000) },
    });

    await request(app.getHttpServer())
      .delete(`/auth/sessions/${target.id}`)
      .set('Authorization', `Bearer ${sessions[0].accessToken}`)
      .expect(204);

    await login('Limit device 11', 'WEB');
    expect(await activeSessionCount()).toBe(10);
  });

  it('keeps the active-session limit under concurrent logins', async () => {
    for (let index = 0; index < 9; index++) {
      await login(`Concurrent device ${index + 1}`, 'WEB');
    }

    const responses = await Promise.all([
      loginRequest('Concurrent device 10'),
      loginRequest('Concurrent device 11'),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(await activeSessionCount()).toBe(10);
  });

  async function login(
    deviceModel: string,
    platform: 'IOS' | 'ANDROID' | 'WEB',
  ): Promise<AuthTokens> {
    const response = await loginRequest(deviceModel, platform).expect(201);
    return response.body as AuthTokens;
  }

  function loginRequest(
    deviceModel: string,
    platform: 'IOS' | 'ANDROID' | 'WEB' = 'WEB',
  ) {
    return request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Device-Model', deviceModel)
      .set('X-Platform', platform)
      .send({ email, password });
  }

  async function getSessions(accessToken: string): Promise<SessionsResponse> {
    const response = await request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    return response.body as SessionsResponse;
  }

  function currentSessionId(response: SessionsResponse): string {
    const currentSession = response.sessions.find(({ current }) => current);

    if (!currentSession) {
      throw new Error('Current session was not returned by the API.');
    }

    return currentSession.id;
  }

  async function activeSessionCount(): Promise<number> {
    return prisma.session.count({
      where: {
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
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
