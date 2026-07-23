import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';

@Injectable()
export class UsernameService {
  generate(email: string): string {
    const baseUsername = email.split('@')[0].trim().toLowerCase();
    const randomDigits = randomInt(1000, 10000);

    return `${baseUsername}${randomDigits}`;
  }
}
