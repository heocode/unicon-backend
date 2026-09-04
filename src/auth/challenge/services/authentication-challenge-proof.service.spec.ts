import { ConfigService } from '@nestjs/config';

import { AuthenticationChallengePurpose } from '../../../generated/prisma/enums';

import {
  AUTHENTICATION_CHALLENGE_HASH_PROTOCOL_VERSION,
  MAGIC_LINK_SECRET_BYTES,
  OTP_UPPER_BOUND,
} from '../constants/challenge-proof.constants';
import type { ChallengeProofContext } from '../types/challenge-proof.type';
import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';
import { AuthenticationChallengeProofService } from './authentication-challenge-proof.service';

describe('AuthenticationChallengeProofService', () => {
  const activeHmacKey = Buffer.alloc(32, 1);
  const historicalHmacKey = Buffer.alloc(32, 2);
  const context: ChallengeProofContext = {
    challengeId: '123e4567-e89b-42d3-a456-426614174000',
    purpose: AuthenticationChallengePurpose.SIGN_IN,
    normalizedIdentity: 'student@example.edu',
  };
  const magicLinkSecret = Buffer.from(
    Array.from({ length: MAGIC_LINK_SECRET_BYTES }, (_, index) => index),
  );
  const magicLinkToken = magicLinkSecret.toString('base64url');

  let randomSource: {
    randomInteger: jest.Mock;
    randomBytes: jest.Mock;
  };
  let service: AuthenticationChallengeProofService;

  beforeEach(() => {
    randomSource = {
      randomInteger: jest.fn(),
      randomBytes: jest.fn(),
    };
    const config = new AuthenticationChallengeConfigService(
      new ConfigService({
        AUTH_CHALLENGE_TTL_SECONDS: 600,
        AUTH_CHALLENGE_MAX_ATTEMPTS: 5,
        AUTH_CHALLENGE_RETENTION_SECONDS: 86_400,
        AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION: 2,
        AUTH_CHALLENGE_HMAC_KEYS: new Map([
          [1, historicalHmacKey],
          [2, activeHmacKey],
        ]),
        AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION: 1,
        AUTH_CHALLENGE_ENCRYPTION_KEYS: new Map([[1, Buffer.alloc(32, 3)]]),
      }),
    );
    service = new AuthenticationChallengeProofService(config, randomSource);
  });

  it.each([
    [0, '000000'],
    [42, '000042'],
    [999_999, '999999'],
  ])('generates canonical OTP %s as %s', (randomValue, expected) => {
    randomSource.randomInteger.mockReturnValue(randomValue);

    expect(service.generateOtp()).toBe(expected);
    expect(randomSource.randomInteger).toHaveBeenCalledWith(OTP_UPPER_BOUND);
  });

  it('generates a canonical 256-bit magic-link token', () => {
    randomSource.randomBytes.mockReturnValue(magicLinkSecret);

    expect(service.generateMagicLinkToken()).toBe(magicLinkToken);
    expect(service.generateMagicLinkToken()).toHaveLength(43);
    expect(randomSource.randomBytes).toHaveBeenCalledWith(
      MAGIC_LINK_SECRET_BYTES,
    );
  });

  it('locks the immutable OTP HMAC v1 encoding with a fixed vector', () => {
    const result = service.hashOtp(context, '004201');

    expect(result.hash.toString('hex')).toBe(
      '07f464d53bc0cc0ab5009bcadff3caa84ae240d9842bb03dbbdcd6959013d066',
    );
    expect(result.hashProtocolVersion).toBe(
      AUTHENTICATION_CHALLENGE_HASH_PROTOCOL_VERSION,
    );
    expect(result.hashKeyVersion).toBe(2);
  });

  it('verifies OTP with its persisted key and protocol versions', () => {
    const stored = service.hashOtp(context, '004201');

    expect(
      service.verifyOtp(
        context,
        '004201',
        stored.hash,
        stored.hashProtocolVersion,
        stored.hashKeyVersion,
      ),
    ).toBe(true);
    expect(
      service.verifyOtp(
        context,
        '004202',
        stored.hash,
        stored.hashProtocolVersion,
        stored.hashKeyVersion,
      ),
    ).toBe(false);
  });

  it('hashes both proofs through one active protocol and key snapshot', () => {
    const proof = { otp: '004201', linkToken: magicLinkToken };
    const result = service.hashProofSet(context, proof);

    expect(result.hashProtocolVersion).toBe(1);
    expect(result.hashKeyVersion).toBe(2);
    expect(result.otpHash).toEqual(service.hashOtp(context, proof.otp).hash);
    expect(result.linkTokenHash).toEqual(
      service.hashMagicLinkToken(context, proof.linkToken).hash,
    );
  });

  it('verifies hashes created with a historical key version', () => {
    const active = service.hashOtp(context, '004201');
    const historicalService = new AuthenticationChallengeProofService(
      new AuthenticationChallengeConfigService(
        new ConfigService({
          AUTH_CHALLENGE_TTL_SECONDS: 600,
          AUTH_CHALLENGE_MAX_ATTEMPTS: 5,
          AUTH_CHALLENGE_RETENTION_SECONDS: 86_400,
          AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION: 1,
          AUTH_CHALLENGE_HMAC_KEYS: new Map([
            [1, historicalHmacKey],
            [2, activeHmacKey],
          ]),
          AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION: 1,
          AUTH_CHALLENGE_ENCRYPTION_KEYS: new Map([[1, Buffer.alloc(32, 3)]]),
        }),
      ),
      randomSource,
    );
    const historicalHash = historicalService.hashOtp(context, '004201');

    expect(active.hash).not.toEqual(historicalHash.hash);
    expect(
      service.verifyOtp(
        context,
        '004201',
        historicalHash.hash,
        historicalHash.hashProtocolVersion,
        historicalHash.hashKeyVersion,
      ),
    ).toBe(true);
  });

  it('verifies a canonical magic-link token', () => {
    const stored = service.hashMagicLinkToken(context, magicLinkToken);

    expect(
      service.verifyMagicLinkToken(
        context,
        magicLinkToken,
        stored.hash,
        stored.hashProtocolVersion,
        stored.hashKeyVersion,
      ),
    ).toBe(true);
    expect(
      service.verifyMagicLinkToken(
        context,
        Buffer.alloc(32, 9).toString('base64url'),
        stored.hash,
        stored.hashProtocolVersion,
        stored.hashKeyVersion,
      ),
    ).toBe(false);
  });

  it('returns false for malformed submitted proofs', () => {
    const otpHash = service.hashOtp(context, '004201');
    const linkHash = service.hashMagicLinkToken(context, magicLinkToken);

    expect(
      service.verifyOtp(
        context,
        '4201',
        otpHash.hash,
        otpHash.hashProtocolVersion,
        otpHash.hashKeyVersion,
      ),
    ).toBe(false);
    expect(
      service.verifyMagicLinkToken(
        context,
        `${magicLinkToken}=`,
        linkHash.hash,
        linkHash.hashProtocolVersion,
        linkHash.hashKeyVersion,
      ),
    ).toBe(false);
  });

  it.each([
    [
      'another challenge',
      { ...context, challengeId: '123e4567-e89b-42d3-a456-426614174001' },
    ],
    [
      'another purpose',
      { ...context, purpose: AuthenticationChallengePurpose.STEP_UP },
    ],
    [
      'another identity',
      { ...context, normalizedIdentity: 'other@example.edu' },
    ],
  ])('binds an OTP hash to %s', (_case, otherContext) => {
    const stored = service.hashOtp(context, '004201');

    expect(
      service.verifyOtp(
        otherContext,
        '004201',
        stored.hash,
        stored.hashProtocolVersion,
        stored.hashKeyVersion,
      ),
    ).toBe(false);
  });

  it('separates OTP and magic-link proof methods', () => {
    const otpHash = service.hashOtp(context, '004201');

    expect(
      service.verifyMagicLinkToken(
        context,
        magicLinkToken,
        otpHash.hash,
        otpHash.hashProtocolVersion,
        otpHash.hashKeyVersion,
      ),
    ).toBe(false);
  });

  it.each([
    [{ ...context, challengeId: context.challengeId.toUpperCase() }],
    [{ ...context, normalizedIdentity: 'Student@example.edu' }],
    [{ ...context, normalizedIdentity: ' student@example.edu' }],
  ])('rejects a non-canonical internal context', (invalidContext) => {
    expect(() => service.hashOtp(invalidContext, '004201')).toThrow();
  });

  it('rejects an unsupported persisted hash protocol', () => {
    const stored = service.hashOtp(context, '004201');

    expect(() =>
      service.verifyOtp(
        context,
        '004201',
        stored.hash,
        2,
        stored.hashKeyVersion,
      ),
    ).toThrow('Authentication challenge hash protocol is unavailable.');
  });

  it('rejects a corrupt persisted hash', () => {
    expect(() =>
      service.verifyOtp(context, '004201', Buffer.alloc(31), 1, 2),
    ).toThrow('Authentication challenge hash is invalid.');
  });
});
