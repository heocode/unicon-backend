import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { SecureToken } from '../types/secure-token.type';

const DEFAULT_TOKEN_EXPIRATION_HOURS = 24;

@Injectable()
export class SecureTokenService {
  generate(expiresInHours = DEFAULT_TOKEN_EXPIRATION_HOURS): SecureToken {
    const token = randomBytes(32).toString('hex');
    const hashedToken = this.hash(token);

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + expiresInHours);

    return {
      token,
      hashedToken,
      expiresAt,
    };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
