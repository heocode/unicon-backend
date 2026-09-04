// NestJS
import { Injectable } from '@nestjs/common';

// Node.js
import { randomBytes, randomInt } from 'crypto';

@Injectable()
export class AuthenticationChallengeRandomSourceService {
  randomInteger(maxExclusive: number): number {
    return randomInt(0, maxExclusive);
  }

  randomBytes(size: number): Buffer {
    return randomBytes(size);
  }
}
