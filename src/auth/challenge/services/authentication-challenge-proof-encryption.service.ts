// NestJS
import { Injectable } from '@nestjs/common';

// Node.js
import { createCipheriv, createDecipheriv } from 'crypto';

// Internal services
import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';
import { AuthenticationChallengeRandomSourceService } from './authentication-challenge-random-source.service';

// Internal constants
import {
  AUTHENTICATION_CHALLENGE_ENCRYPTION_ALGORITHM,
  AUTHENTICATION_CHALLENGE_ENCRYPTION_IV_BYTES,
  AUTHENTICATION_CHALLENGE_ENCRYPTION_PROTOCOL_VERSION,
  AUTHENTICATION_CHALLENGE_ENCRYPTION_TAG_BYTES,
} from '../constants/challenge-proof.constants';

// Internal errors
import { AuthenticationChallengeEncryptionConfigurationError } from '../errors/authentication-challenge-encryption-configuration.error';
import { CorruptedAuthenticationChallengeProofError } from '../errors/corrupted-authentication-challenge-proof.error';

// Internal types
import type {
  ChallengeProofContext,
  EncryptedChallengeProofData,
  TransientChallengeDeliveryProof,
} from '../types/challenge-proof.type';

// Internal utilities
import {
  decodeAuthenticationChallengeEnvelopePayloadV1,
  encodeAuthenticationChallengeEnvelopeAadV1,
  encodeAuthenticationChallengeEnvelopePayloadV1,
} from '../utils/authentication-challenge-envelope-v1.util';

@Injectable()
export class AuthenticationChallengeProofEncryptionService {
  constructor(
    private readonly config: AuthenticationChallengeConfigService,
    private readonly randomSource: AuthenticationChallengeRandomSourceService,
  ) {}

  encrypt(
    context: ChallengeProofContext,
    proof: TransientChallengeDeliveryProof,
  ): EncryptedChallengeProofData {
    const encryptionProtocolVersion =
      AUTHENTICATION_CHALLENGE_ENCRYPTION_PROTOCOL_VERSION;
    const encryptionKeyVersion = this.config.activeEncryptionKeyVersion;
    const key = this.resolveKey(encryptionKeyVersion);

    try {
      return this.encryptV1(
        context,
        proof,
        encryptionProtocolVersion,
        encryptionKeyVersion,
        key,
      );
    } finally {
      key.fill(0);
    }
  }

  decrypt(
    context: ChallengeProofContext,
    encryptedProof: EncryptedChallengeProofData,
  ): TransientChallengeDeliveryProof {
    if (
      encryptedProof.encryptionProtocolVersion !==
      AUTHENTICATION_CHALLENGE_ENCRYPTION_PROTOCOL_VERSION
    ) {
      throw new AuthenticationChallengeEncryptionConfigurationError(
        'Authentication challenge encryption protocol is unavailable.',
      );
    }

    const key = this.resolveKey(encryptedProof.encryptionKeyVersion);

    try {
      return this.decryptV1(context, encryptedProof, key);
    } finally {
      key.fill(0);
    }
  }

  private encryptV1(
    context: ChallengeProofContext,
    proof: TransientChallengeDeliveryProof,
    encryptionProtocolVersion: number,
    encryptionKeyVersion: number,
    key: Buffer,
  ): EncryptedChallengeProofData {
    const aad = encodeAuthenticationChallengeEnvelopeAadV1(context);
    const payload = encodeAuthenticationChallengeEnvelopePayloadV1(proof);
    const proofEncryptionIv = this.randomSource.randomBytes(
      AUTHENTICATION_CHALLENGE_ENCRYPTION_IV_BYTES,
    );

    try {
      const cipher = createCipheriv(
        AUTHENTICATION_CHALLENGE_ENCRYPTION_ALGORITHM,
        key,
        proofEncryptionIv,
        { authTagLength: AUTHENTICATION_CHALLENGE_ENCRYPTION_TAG_BYTES },
      );
      cipher.setAAD(aad);

      const encryptedProof = Buffer.concat([
        cipher.update(payload),
        cipher.final(),
      ]);
      const proofEncryptionTag = cipher.getAuthTag();

      return {
        encryptedProof,
        proofEncryptionIv: Buffer.from(proofEncryptionIv),
        proofEncryptionTag,
        encryptionProtocolVersion,
        encryptionKeyVersion,
      };
    } finally {
      payload.fill(0);
    }
  }

  private decryptV1(
    context: ChallengeProofContext,
    encryptedProof: EncryptedChallengeProofData,
    key: Buffer,
  ): TransientChallengeDeliveryProof {
    const aad = encodeAuthenticationChallengeEnvelopeAadV1(context);
    const ciphertext = Buffer.from(encryptedProof.encryptedProof);
    const iv = Buffer.from(encryptedProof.proofEncryptionIv);
    const tag = Buffer.from(encryptedProof.proofEncryptionTag);

    if (
      ciphertext.length === 0 ||
      iv.length !== AUTHENTICATION_CHALLENGE_ENCRYPTION_IV_BYTES ||
      tag.length !== AUTHENTICATION_CHALLENGE_ENCRYPTION_TAG_BYTES
    ) {
      throw new CorruptedAuthenticationChallengeProofError();
    }

    let payload: Buffer | undefined;

    try {
      const decipher = createDecipheriv(
        AUTHENTICATION_CHALLENGE_ENCRYPTION_ALGORITHM,
        key,
        iv,
        { authTagLength: AUTHENTICATION_CHALLENGE_ENCRYPTION_TAG_BYTES },
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      return decodeAuthenticationChallengeEnvelopePayloadV1(payload);
    } catch {
      throw new CorruptedAuthenticationChallengeProofError();
    } finally {
      payload?.fill(0);
    }
  }

  private resolveKey(version: number): Buffer {
    try {
      return this.config.getEncryptionKey(version);
    } catch {
      throw new AuthenticationChallengeEncryptionConfigurationError(
        'Authentication challenge encryption key version is unavailable.',
      );
    }
  }
}
