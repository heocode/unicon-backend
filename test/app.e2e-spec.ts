import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { configureApp } from '../src/configure-app';

describe('Application validation (e2e)', () => {
  let app: INestApplication<App>;

  const authService = {
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
  });

  it('rejects a weak registration password before calling AuthService', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'student@my.centennialcollege.ca',
        password: 'password',
        confirmedPassword: 'password',
      })
      .expect(400);

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
      .expect(400);

    expect(authService.register).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    await app.close();
  });
});
