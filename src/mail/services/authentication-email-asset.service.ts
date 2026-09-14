// NestJS
import { Injectable } from '@nestjs/common';

// Node.js
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Internal constants
import {
  AUTHENTICATION_EMAIL_LOGO_V1_MAX_BYTES,
  AUTHENTICATION_EMAIL_LOGO_V1_SHA256,
} from '../../config/constants/authentication-email.constants';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LOGO_V1_PATH = 'assets/email/unicon-logo-v1.png';

@Injectable()
export class AuthenticationEmailAssetService {
  private readonly logoV1: Buffer;

  constructor() {
    this.logoV1 = this.loadLogoV1();
  }

  getLogoV1(): Uint8Array {
    return Uint8Array.from(this.logoV1);
  }

  private loadLogoV1(): Buffer {
    let content: Buffer;

    try {
      content = readFileSync(resolve(process.cwd(), LOGO_V1_PATH));
    } catch {
      throw new Error('Authentication email logo asset is unavailable.');
    }

    const digest = createHash('sha256').update(content).digest('hex');
    if (
      content.length === 0 ||
      content.length > AUTHENTICATION_EMAIL_LOGO_V1_MAX_BYTES ||
      !content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
      digest !== AUTHENTICATION_EMAIL_LOGO_V1_SHA256
    ) {
      throw new Error('Authentication email logo asset is invalid.');
    }

    return content;
  }
}
