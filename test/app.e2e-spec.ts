import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { configureApp } from '../src/configure-app';
import type { LoginDto } from '../src/auth/dtos/login.dto';
import type { SessionMetadata } from '../src/auth/types/session-metadata.type';

describe('Application validation (e2e)', () => {
  let app: INestApplication<App>;
  let receivedLogin: { dto: LoginDto; metadata: SessionMetadata } | undefined;

  const login = jest.fn((dto: LoginDto, metadata: SessionMetadata) => {
    receivedLogin = { dto, metadata };

    return {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    };
  });
  const authService = {
    login,
    register: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthService)
      .useValue(authService)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    receivedLogin = undefined;
  });

  it('rejects a weak registration password before calling AuthService', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'student@my.centennialcollege.ca',
        password: 'password',
        confirmedPassword: 'password',
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body).toEqual({
          code: 'VALIDATION_FAILED',
          message: 'The request is invalid.',
          details: {
            violations: [
              {
                field: 'password',
                code: 'WEAK_PASSWORD',
                message: 'Password does not meet the security requirements.',
              },
            ],
          },
        });
      });

    expect(authService.register).not.toHaveBeenCalled();
  });

  it('rejects properties that are not declared in the DTO', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'student@my.centennialcollege.ca',
        password: 'Password1!',
        confirmedPassword: 'Password1!',
        role: 'ADMIN',
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: {
            violations: [
              {
                field: 'role',
                code: 'UNKNOWN_FIELD',
                message: 'This field is not allowed.',
              },
            ],
          },
        });
      });

    expect(authService.register).not.toHaveBeenCalled();
  });

  it('passes normalized device metadata to the login service', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Device-Model-Identifier', ' iPhone17,1 ')
      .set('X-Device-Model', ' iPhone 16 Pro ')
      .set('X-Platform', ' ios ')
      .set('X-OS-Version', ' 18.6 ')
      .set('X-App-Version', ' 1.4.2 ')
      .set('User-Agent', ' Unicon/1.0 (iOS 18) ')
      .send({
        email: 'student@my.centennialcollege.ca',
        password: 'Password1!',
      })
      .expect(201);

    expect(authService.login).toHaveBeenCalledTimes(1);

    expect(receivedLogin?.metadata).toMatchObject({
      userAgent: 'Unicon/1.0 (iOS 18)',
      deviceModelIdentifier: 'iPhone17,1',
      deviceModel: 'iPhone 16 Pro',
      platform: 'IOS',
      osVersion: '18.6',
      appVersion: '1.4.2',
    });
    expect(typeof receivedLogin?.metadata.ipAddress).toBe('string');
  });

  it('returns a stable error for malformed JSON', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400)
      .expect({
        code: 'MALFORMED_JSON',
        message: 'The request body contains malformed JSON.',
      });

    expect(authService.login).not.toHaveBeenCalled();
  });

  it('distinguishes missing access and refresh credentials', async () => {
    await request(app.getHttpServer()).get('/profile/me').expect(401).expect({
      code: 'ACCESS_TOKEN_REQUIRED',
      message: 'An access token is required.',
    });

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .expect(401)
      .expect({
        code: 'REFRESH_TOKEN_REQUIRED',
        message: 'A refresh token is required.',
      });
  });

  afterAll(async () => {
    await app.close();
  });
});
