import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { SecureToken } from '../types/secure-token.type';

@Injectable()
export class SecureTokenService {
  generate(expiresInHours = 24): SecureToken {
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
