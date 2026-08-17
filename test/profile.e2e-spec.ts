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

describe('Profile with PostgreSQL (e2e)', () => {
  const email = 'profile-e2e@my.centennialcollege.ca';
  const password = 'Password1!';

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mailService: MailService;
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
    passwordHash = await app.get(PasswordService).hash(password);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest
      .spyOn(mailService, 'sendNewSessionEmail')
      .mockResolvedValue('test-provider-message-id');

    await cleanDatabase();

    const university = await prisma.university.create({
      data: { name: 'Profile E2E University' },
    });

    await prisma.user.create({
      data: {
        email,
        username: 'profile-e2e-user',
        emailVerified: true,
        passwordHash,
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

  it('returns only the authenticated user public profile', async () => {
    const tokens = await login();

    await request(app.getHttpServer())
      .get('/profile/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          username: 'profile-e2e-user',
          email,
          emailVerified: true,
          role: 'MEMBER',
          university: {
            name: 'Profile E2E University',
          },
        });
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('createdAt');
        expect(body).not.toHaveProperty('passwordHash');
        expect(body).not.toHaveProperty('status');
        expect(body).not.toHaveProperty('sessions');
      });
  });

  it('rejects a request without an access token', async () => {
    await request(app.getHttpServer()).get('/profile/me').expect(401);
  });

  it('rejects an access token after its session is revoked', async () => {
    const tokens = await login();

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(201);

    await request(app.getHttpServer())
      .get('/profile/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(401);
  });

  async function login(): Promise<AuthTokens> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
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
