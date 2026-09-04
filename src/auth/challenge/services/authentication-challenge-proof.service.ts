// NestJS
import { Injectable, InternalServerErrorException } from '@nestjs/common';

// Node.js
import { createHmac, timingSafeEqual } from 'crypto';

// Prisma
import { AuthenticationChallengePurpose } from '../../../generated/prisma/enums';

// Internal services
import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';
import { AuthenticationChallengeRandomSourceService } from './authentication-challenge-random-source.service';

// Internal constants
import {
  AUTHENTICATION_CHALLENGE_HASH_PROTOCOL_VERSION,
  AUTHENTICATION_CHALLENGE_HMAC_DOMAIN,
  MAGIC_LINK_SECRET_BYTES,
  OTP_LENGTH,
  OTP_UPPER_BOUND,
  SHA_256_BYTES,
} from '../constants/challenge-proof.constants';

// Internal types
import {
  ChallengeProofMethod,
  type ChallengeProofContext,
  type HashedChallengeProof,
} from '../types/challenge-proof.type';

// Internal utilities
import { encodeLengthPrefixedFields } from '../utils/encode-length-prefixed-fields.util';
import {
  parseCanonicalMagicLinkToken,
  parseCanonicalOtp,
} from '../utils/parse-canonical-challenge-proof.util';

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Injectable()
export class AuthenticationChallengeProofService {
  constructor(
    private readonly config: AuthenticationChallengeConfigService,
    private readonly randomSource: AuthenticationChallengeRandomSourceService,
  ) {}

  generateOtp(): string {
    return this.randomSource
      .randomInteger(OTP_UPPER_BOUND)
      .toString()
      .padStart(OTP_LENGTH, '0');
  }

  generateMagicLinkToken(): string {
    return this.randomSource
      .randomBytes(MAGIC_LINK_SECRET_BYTES)
      .toString('base64url');
  }

  hashOtp(context: ChallengeProofContext, otp: string): HashedChallengeProof {
    return this.hashProof(
      context,
      ChallengeProofMethod.OTP,
      parseCanonicalOtp(otp),
      this.config.activeHmacKeyVersion,
    );
  }

  hashMagicLinkToken(
    context: ChallengeProofContext,
    token: string,
  ): HashedChallengeProof {
    return this.hashProof(
      context,
      ChallengeProofMethod.MAGIC_LINK,
      parseCanonicalMagicLinkToken(token),
      this.config.activeHmacKeyVersion,
    );
  }

  verifyOtp(
    context: ChallengeProofContext,
    otp: string,
    storedHash: Uint8Array,
    hashProtocolVersion: number,
    hashKeyVersion: number,
  ): boolean {
    let proof: Buffer;

    try {
      proof = parseCanonicalOtp(otp);
    } catch {
      return false;
    }

    return this.verifyProof(
      context,
      ChallengeProofMethod.OTP,
      proof,
      storedHash,
      hashProtocolVersion,
      hashKeyVersion,
    );
  }

  verifyMagicLinkToken(
    context: ChallengeProofContext,
    token: string,
    storedHash: Uint8Array,
    hashProtocolVersion: number,
    hashKeyVersion: number,
  ): boolean {
    let proof: Buffer;

    try {
      proof = parseCanonicalMagicLinkToken(token);
    } catch {
      return false;
    }

    return this.verifyProof(
      context,
      ChallengeProofMethod.MAGIC_LINK,
      proof,
      storedHash,
      hashProtocolVersion,
      hashKeyVersion,
    );
  }

  private verifyProof(
    context: ChallengeProofContext,
    method: ChallengeProofMethod,
    proof: Buffer,
    storedHash: Uint8Array,
    hashProtocolVersion: number,
    hashKeyVersion: number,
  ): boolean {
    if (storedHash.byteLength !== SHA_256_BYTES) {
      throw new InternalServerErrorException(
        'Authentication challenge hash is invalid.',
      );
    }

    const candidate = this.hashProof(
      context,
      method,
      proof,
      hashKeyVersion,
      hashProtocolVersion,
    ).hash;

    return timingSafeEqual(candidate, storedHash);
  }

  private hashProof(
    context: ChallengeProofContext,
    method: ChallengeProofMethod,
    proof: Buffer,
    hashKeyVersion: number,
    hashProtocolVersion = AUTHENTICATION_CHALLENGE_HASH_PROTOCOL_VERSION,
  ): HashedChallengeProof {
    this.assertSupportedProtocol(hashProtocolVersion);
    this.assertCanonicalContext(context);

    const payload = encodeLengthPrefixedFields([
      Buffer.from(AUTHENTICATION_CHALLENGE_HMAC_DOMAIN, 'utf8'),
      Buffer.from(method, 'utf8'),
      Buffer.from(context.purpose, 'utf8'),
      Buffer.from(context.challengeId, 'utf8'),
      Buffer.from(context.normalizedIdentity, 'utf8'),
      proof,
    ]);
    const key = this.config.getHmacKey(hashKeyVersion);
    const hash = createHmac('sha256', key).update(payload).digest();

    return {
      hash,
      hashProtocolVersion,
      hashKeyVersion,
    };
  }

  private assertSupportedProtocol(hashProtocolVersion: number): void {
    if (
      hashProtocolVersion !== AUTHENTICATION_CHALLENGE_HASH_PROTOCOL_VERSION
    ) {
      throw new InternalServerErrorException(
        'Authentication challenge hash protocol is unavailable.',
      );
    }
  }

  private assertCanonicalContext(context: ChallengeProofContext): void {
    if (!CANONICAL_UUID_PATTERN.test(context.challengeId)) {
      throw new TypeError(
        'Challenge ID must use its canonical representation.',
      );
    }

    if (
      context.normalizedIdentity.length === 0 ||
      context.normalizedIdentity !== context.normalizedIdentity.trim() ||
      context.normalizedIdentity !== context.normalizedIdentity.toLowerCase()
    ) {
      throw new TypeError('Challenge identity must already be normalized.');
    }

    if (
      !Object.values(AuthenticationChallengePurpose).includes(context.purpose)
    ) {
      throw new TypeError('Challenge purpose is invalid.');
    }
  }
}
