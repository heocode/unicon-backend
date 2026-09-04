import { ConfigService } from '@nestjs/config';

import { AuthenticationChallengePurpose } from '../../../generated/prisma/enums';

import type { ChallengeProofContext } from '../types/challenge-proof.type';
import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';
import { AuthenticationChallengeProofEncryptionService } from './authentication-challenge-proof-encryption.service';
import { AuthenticationChallengeProofFactoryService } from './authentication-challenge-proof-factory.service';
import { AuthenticationChallengeProofService } from './authentication-challenge-proof.service';

describe('AuthenticationChallengeProofFactoryService', () => {
  const context: ChallengeProofContext = {
    challengeId: '123e4567-e89b-42d3-a456-426614174000',
    purpose: AuthenticationChallengePurpose.SIGN_IN,
    normalizedIdentity: 'student@example.edu',
  };

  it('generates one transient proof set and splits persistence by concern', () => {
    const deliveryProof = {
      otp: '004201',
      linkToken: Buffer.alloc(32, 7).toString('base64url'),
    };
    const hashing = {
      otpHash: Buffer.alloc(32, 1),
      linkTokenHash: Buffer.alloc(32, 2),
      hashProtocolVersion: 1,
      hashKeyVersion: 3,
    };
    const encryption = {
      encryptedProof: Buffer.alloc(64, 4),
      proofEncryptionIv: Buffer.alloc(12, 5),
      proofEncryptionTag: Buffer.alloc(16, 6),
      encryptionProtocolVersion: 1,
      encryptionKeyVersion: 4,
    };
    const hashingService = {
      generateOtp: jest.fn().mockReturnValue(deliveryProof.otp),
      generateMagicLinkToken: jest
        .fn()
        .mockReturnValue(deliveryProof.linkToken),
      hashProofSet: jest.fn().mockReturnValue(hashing),
    };
    const encryptionService = {
      encrypt: jest.fn().mockReturnValue(encryption),
    };
    const factory = new AuthenticationChallengeProofFactoryService(
      hashingService,
      encryptionService,
    );

    expect(factory.generate(context)).toEqual({
      persistence: { hashing, encryption },
      deliveryProof,
    });
    expect(hashingService.generateOtp).toHaveBeenCalledTimes(1);
    expect(hashingService.generateMagicLinkToken).toHaveBeenCalledTimes(1);
    expect(hashingService.hashProofSet).toHaveBeenCalledWith(
      context,
      deliveryProof,
    );
    expect(encryptionService.encrypt).toHaveBeenCalledWith(
      context,
      deliveryProof,
    );
  });

  it('produces hashes and an envelope for exactly the returned proof', () => {
    const hmacKey = Buffer.alloc(32, 1);
    const encryptionKey = Buffer.alloc(32, 2);
    const linkSecret = Buffer.alloc(32, 3);
    const config = new AuthenticationChallengeConfigService(
      new ConfigService({
        AUTH_CHALLENGE_TTL_SECONDS: 600,
        AUTH_CHALLENGE_MAX_ATTEMPTS: 5,
        AUTH_CHALLENGE_RETENTION_SECONDS: 86_400,
        AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION: 1,
        AUTH_CHALLENGE_HMAC_KEYS: new Map([[1, hmacKey]]),
        AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION: 1,
        AUTH_CHALLENGE_ENCRYPTION_KEYS: new Map([[1, encryptionKey]]),
      }),
    );
    const randomSource = {
      randomInteger: jest.fn().mockReturnValue(4_201),
      randomBytes: jest.fn((size: number) =>
        size === 32 ? linkSecret : Buffer.alloc(size, 4),
      ),
    };
    const hashingService = new AuthenticationChallengeProofService(
      config,
      randomSource,
    );
    const encryptionService = new AuthenticationChallengeProofEncryptionService(
      config,
      randomSource,
    );
    const factory = new AuthenticationChallengeProofFactoryService(
      hashingService,
      encryptionService,
    );

    const generated = factory.generate(context);

    expect(generated.deliveryProof).toEqual({
      otp: '004201',
      linkToken: linkSecret.toString('base64url'),
    });
    expect(
      hashingService.verifyOtp(
        context,
        generated.deliveryProof.otp,
        generated.persistence.hashing.otpHash,
        generated.persistence.hashing.hashProtocolVersion,
        generated.persistence.hashing.hashKeyVersion,
      ),
    ).toBe(true);
    expect(
      hashingService.verifyMagicLinkToken(
        context,
        generated.deliveryProof.linkToken,
        generated.persistence.hashing.linkTokenHash,
        generated.persistence.hashing.hashProtocolVersion,
        generated.persistence.hashing.hashKeyVersion,
      ),
    ).toBe(true);
    expect(
      encryptionService.decrypt(context, generated.persistence.encryption),
    ).toEqual(generated.deliveryProof);
  });
});
