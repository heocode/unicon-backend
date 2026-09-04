// NestJS
import { Injectable } from '@nestjs/common';

// Internal services
import { AuthenticationChallengeProofEncryptionService } from './authentication-challenge-proof-encryption.service';
import { AuthenticationChallengeProofService } from './authentication-challenge-proof.service';

// Internal types
import type {
  ChallengeProofContext,
  GeneratedChallengeProof,
  TransientChallengeDeliveryProof,
} from '../types/challenge-proof.type';

@Injectable()
export class AuthenticationChallengeProofFactoryService {
  constructor(
    private readonly hashingService: AuthenticationChallengeProofService,
    private readonly encryptionService: AuthenticationChallengeProofEncryptionService,
  ) {}

  generate(context: ChallengeProofContext): GeneratedChallengeProof {
    const deliveryProof: TransientChallengeDeliveryProof = {
      otp: this.hashingService.generateOtp(),
      linkToken: this.hashingService.generateMagicLinkToken(),
    };

    return {
      persistence: {
        hashing: this.hashingService.hashProofSet(context, deliveryProof),
        encryption: this.encryptionService.encrypt(context, deliveryProof),
      },
      deliveryProof,
    };
  }
}
