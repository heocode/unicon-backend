import { ConfigService } from '@nestjs/config';

import { createCipheriv } from 'crypto';

import { AuthenticationChallengePurpose } from '../../../generated/prisma/enums';

import {
  AUTHENTICATION_CHALLENGE_ENCRYPTION_IV_BYTES,
  AUTHENTICATION_CHALLENGE_ENCRYPTION_ALGORITHM,
  AUTHENTICATION_CHALLENGE_ENCRYPTION_PROTOCOL_VERSION,
  AUTHENTICATION_CHALLENGE_ENCRYPTION_TAG_BYTES,
} from '../constants/challenge-proof.constants';
import { AuthenticationChallengeEncryptionConfigurationError } from '../errors/authentication-challenge-encryption-configuration.error';
import { CorruptedAuthenticationChallengeProofError } from '../errors/corrupted-authentication-challenge-proof.error';
import type {
  ChallengeProofContext,
  EncryptedChallengeProofData,
  TransientChallengeDeliveryProof,
} from '../types/challenge-proof.type';
import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';
import { AuthenticationChallengeProofEncryptionService } from './authentication-challenge-proof-encryption.service';
import { encodeAuthenticationChallengeEnvelopeAadV1 } from '../utils/authentication-challenge-envelope-v1.util';
import { encodeLengthPrefixedFields } from '../utils/encode-length-prefixed-fields.util';

describe('AuthenticationChallengeProofEncryptionService', () => {
  const encryptionKey = Buffer.alloc(32, 3);
  const fixedIv = Buffer.from(
    Array.from(
      { length: AUTHENTICATION_CHALLENGE_ENCRYPTION_IV_BYTES },
      (_, index) => index,
    ),
  );
  const context: ChallengeProofContext = {
    challengeId: '123e4567-e89b-42d3-a456-426614174000',
    purpose: AuthenticationChallengePurpose.SIGN_IN,
    normalizedIdentity: 'student@example.edu',
  };
  const proof: TransientChallengeDeliveryProof = {
    otp: '004201',
    linkToken: Buffer.from(
      Array.from({ length: 32 }, (_, index) => index),
    ).toString('base64url'),
  };

  let randomSource: { randomBytes: jest.Mock };
  let service: AuthenticationChallengeProofEncryptionService;

  beforeEach(() => {
    randomSource = { randomBytes: jest.fn().mockReturnValue(fixedIv) };
    service = createService(
      new Map([
        [1, Buffer.alloc(32, 4)],
        [2, encryptionKey],
      ]),
      2,
    );
  });

  function createService(
    encryptionKeys: ReadonlyMap<number, Buffer>,
    activeVersion: number,
  ): AuthenticationChallengeProofEncryptionService {
    const config = new AuthenticationChallengeConfigService(
      new ConfigService({
        AUTH_CHALLENGE_TTL_SECONDS: 600,
        AUTH_CHALLENGE_MAX_ATTEMPTS: 5,
        AUTH_CHALLENGE_RETENTION_SECONDS: 86_400,
        AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION: 1,
        AUTH_CHALLENGE_HMAC_KEYS: new Map([[1, Buffer.alloc(32, 1)]]),
        AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION: activeVersion,
        AUTH_CHALLENGE_ENCRYPTION_KEYS: encryptionKeys,
      }),
    );

    return new AuthenticationChallengeProofEncryptionService(
      config,
      randomSource,
    );
  }

  it('locks the complete immutable AES-GCM protocol v1 vector', () => {
    const encrypted = service.encrypt(context, proof);

    expect(encrypted.encryptionProtocolVersion).toBe(
      AUTHENTICATION_CHALLENGE_ENCRYPTION_PROTOCOL_VERSION,
    );
    expect(encrypted.encryptionKeyVersion).toBe(2);
    expect(Buffer.from(encrypted.proofEncryptionIv)).toEqual(fixedIv);
    expect(Buffer.from(encrypted.encryptedProof).toString('hex')).toBe(
      '47b17665ba8e346d5eab48c7929defdbdcb81f5255bacc7f7bb36c04f238774c151a0fea5c7e156035637e7c0246217ab2248f9cc1adfcf0bb44b4d87ef54c8e516d81d261aeea30f66f14cf6485ac6671f8bb46ef21e4de5177ac',
    );
    expect(Buffer.from(encrypted.proofEncryptionTag).toString('hex')).toBe(
      'ef876fd66d4b47b8c7b31383ee394a22',
    );
    expect(randomSource.randomBytes).toHaveBeenCalledWith(
      AUTHENTICATION_CHALLENGE_ENCRYPTION_IV_BYTES,
    );
  });

  it('recovers exactly the same delivery proof', () => {
    const encrypted = service.encrypt(context, proof);

    expect(service.decrypt(context, encrypted)).toEqual(proof);
  });

  it('uses the persisted historical key version for decryption', () => {
    const encrypted = service.encrypt(context, proof);
    const rotatedService = createService(
      new Map([
        [2, encryptionKey],
        [3, Buffer.alloc(32, 5)],
      ]),
      3,
    );

    expect(rotatedService.decrypt(context, encrypted)).toEqual(proof);
  });

  it.each([
    'encryptedProof',
    'proofEncryptionIv',
    'proofEncryptionTag',
  ] as const)('rejects tampered %s as corrupted proof', (field) => {
    const encrypted = service.encrypt(context, proof);
    const tamperedValue = Buffer.from(encrypted[field]);
    tamperedValue[0] ^= 1;

    expect(() =>
      service.decrypt(context, { ...encrypted, [field]: tamperedValue }),
    ).toThrow(CorruptedAuthenticationChallengeProofError);
  });

  it.each([
    { ...context, challengeId: '123e4567-e89b-42d3-a456-426614174001' },
    { ...context, purpose: AuthenticationChallengePurpose.STEP_UP },
    { ...context, normalizedIdentity: 'other@example.edu' },
  ])('rejects an envelope moved to another context', (otherContext) => {
    const encrypted = service.encrypt(context, proof);

    expect(() => service.decrypt(otherContext, encrypted)).toThrow(
      CorruptedAuthenticationChallengeProofError,
    );
  });

  it('distinguishes an unsupported protocol from corrupted proof', () => {
    const encrypted = service.encrypt(context, proof);

    expect(() =>
      service.decrypt(context, {
        ...encrypted,
        encryptionProtocolVersion: 2,
      }),
    ).toThrow(AuthenticationChallengeEncryptionConfigurationError);
  });

  it('distinguishes an unavailable key version from corrupted proof', () => {
    const encrypted = service.encrypt(context, proof);

    expect(() =>
      service.decrypt(context, { ...encrypted, encryptionKeyVersion: 99 }),
    ).toThrow(AuthenticationChallengeEncryptionConfigurationError);
  });

  it('classifies an authenticated but malformed payload as corrupted proof', () => {
    const aad = encodeAuthenticationChallengeEnvelopeAadV1(context);
    const malformedPayload = encodeLengthPrefixedFields([
      Buffer.from('wrong-payload-domain'),
      Buffer.from(proof.otp),
      Buffer.alloc(32),
    ]);
    const cipher = createCipheriv(
      AUTHENTICATION_CHALLENGE_ENCRYPTION_ALGORITHM,
      encryptionKey,
      fixedIv,
      { authTagLength: AUTHENTICATION_CHALLENGE_ENCRYPTION_TAG_BYTES },
    );
    cipher.setAAD(aad);
    const encrypted: EncryptedChallengeProofData = {
      encryptedProof: Buffer.concat([
        cipher.update(malformedPayload),
        cipher.final(),
      ]),
      proofEncryptionIv: fixedIv,
      proofEncryptionTag: cipher.getAuthTag(),
      encryptionProtocolVersion: 1,
      encryptionKeyVersion: 2,
    };

    expect(() => service.decrypt(context, encrypted)).toThrow(
      CorruptedAuthenticationChallengeProofError,
    );
  });

  it.each([
    { encryptedProof: Buffer.alloc(0) },
    { proofEncryptionIv: Buffer.alloc(11) },
    { proofEncryptionTag: Buffer.alloc(15) },
  ])('rejects malformed envelope storage as corruption', (override) => {
    const encrypted = service.encrypt(context, proof);

    expect(() =>
      service.decrypt(context, { ...encrypted, ...override }),
    ).toThrow(CorruptedAuthenticationChallengeProofError);
  });

  it('uses a fresh IV to produce a different encrypted envelope', () => {
    const first = service.encrypt(context, proof);
    randomSource.randomBytes.mockReturnValue(Buffer.alloc(12, 9));
    const second = service.encrypt(context, proof);

    expect(second.proofEncryptionIv).not.toEqual(first.proofEncryptionIv);
    expect(second.encryptedProof).not.toEqual(first.encryptedProof);
  });
});
