import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PasswordService } from '../src/auth/services/password.service';
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
    passwordHash = await app.get(PasswordService).hash(password);
  });

  beforeEach(async () => {
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
