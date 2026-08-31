import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SwaggerModule } from '@nestjs/swagger';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { createSwaggerConfig } from '../src/swagger/swagger.config';

const expectedOperations = {
  '/auth/register': ['post'],
  '/auth/login': ['post'],
  '/auth/verify-email': ['post'],
  '/auth/resend-verification': ['post'],
  '/auth/forgot-password': ['post'],
  '/auth/reset-password': ['post'],
  '/auth/refresh': ['post'],
  '/auth/logout': ['post'],
  '/auth/sessions': ['get'],
  '/auth/sessions/{sessionId}': ['patch', 'delete'],
  '/auth/sessions/others': ['delete'],
  '/account/password': ['patch'],
  '/account/deletion': ['post'],
  '/account/deletion/cancel': ['post'],
  '/profile/me': ['get'],
} as const;

describe('Public OpenAPI contract (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents every MVP operation with an explicit success response', () => {
    const document = SwaggerModule.createDocument(app, createSwaggerConfig());

    expect(Object.keys(document.paths).sort()).toEqual(
      Object.keys(expectedOperations).sort(),
    );

    for (const [path, methods] of Object.entries(expectedOperations)) {
      for (const method of methods) {
        const operation = document.paths[path]?.[method];
        expect(operation).toBeDefined();

        const success = Object.entries(operation?.responses ?? {}).find(
          ([status]) => status.startsWith('2'),
        );
        expect(success).toBeDefined();

        if (success?.[0] !== '204') {
          expect(success?.[1]).toHaveProperty(
            'content.application/json.schema',
          );
        }
      }
    }
  });

  it('declares distinct access and refresh bearer schemes', () => {
    const document = SwaggerModule.createDocument(app, createSwaggerConfig());

    expect(document.components?.securitySchemes).toMatchObject({
      'access-token': {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      'refresh-token': {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    });
    expect(document.paths['/auth/refresh']?.post?.security).toEqual([
      { 'refresh-token': [] },
    ]);
    expect(document.paths['/profile/me']?.get?.security).toEqual([
      { 'access-token': [] },
    ]);
  });

  it('excludes deferred authentication surfaces', () => {
    const document = SwaggerModule.createDocument(app, createSwaggerConfig());
    const paths = Object.keys(document.paths).join(' ');

    expect(paths).not.toMatch(/totp|passkey|oauth|email-otp/iu);
  });

  it('emits named success and shared error schemas', () => {
    const document = SwaggerModule.createDocument(app, createSwaggerConfig());
    const schemas = document.components?.schemas ?? {};

    expect(schemas).toHaveProperty('AuthTokensResponseDto');
    expect(schemas).toHaveProperty('RegistrationResponseDto');
    expect(schemas).toHaveProperty('EmailVerificationResponseDto');
    expect(schemas).toHaveProperty('ResendVerificationResponseDto');
    expect(schemas).toHaveProperty('PublicErrorResponseDto');
    expect(schemas).toHaveProperty('ValidationErrorDetailsDto');
    expect(schemas.AuthTokensResponseDto).toHaveProperty(
      'properties.accessToken',
    );
    expect(schemas.EmailVerificationResponseDto).toHaveProperty(
      'properties.refreshToken',
    );
    expect(schemas.EmailVerificationResponseDto).toHaveProperty(
      'properties.message',
    );
  });

  it('documents registration with one password field', () => {
    const document = SwaggerModule.createDocument(app, createSwaggerConfig());
    const schema = document.components?.schemas?.RegisterDto;

    expect(schema).toBeDefined();
    expect(schema).toHaveProperty('required', ['email', 'password']);
    expect(schema).toHaveProperty('properties.email');
    expect(schema).toHaveProperty('properties.password');
    expect(schema).not.toHaveProperty('properties.confirmedPassword');
  });

  it('documents accepted informational session metadata headers', () => {
    const document = SwaggerModule.createDocument(app, createSwaggerConfig());

    for (const path of [
      '/auth/login',
      '/auth/verify-email',
      '/auth/forgot-password',
      '/auth/reset-password',
      '/account/deletion/cancel',
    ]) {
      const parameters = document.paths[path]?.post?.parameters ?? [];
      const names = parameters
        .filter((parameter) => 'name' in parameter)
        .map((parameter) => parameter.name);

      expect(names).toEqual(
        expect.arrayContaining([
          'User-Agent',
          'X-Device-Model-Identifier',
          'X-Device-Model',
          'X-Platform',
          'X-OS-Version',
          'X-App-Version',
        ]),
      );
    }
  });

  it('documents logout as an empty 204 response', () => {
    const document = SwaggerModule.createDocument(app, createSwaggerConfig());
    const response = document.paths['/auth/logout']?.post?.responses?.['204'];

    expect(response).toBeDefined();
    expect(response).not.toHaveProperty('content');
  });
});
