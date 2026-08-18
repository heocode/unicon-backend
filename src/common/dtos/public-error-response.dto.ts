import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  PUBLIC_ERROR_CODES,
  type PublicErrorCode,
} from '../types/public-error-code.type';

export class PublicErrorResponseDto {
  @ApiProperty({
    description:
      'Stable machine-readable error code. Clients must branch on this field instead of message.',
    enum: PUBLIC_ERROR_CODES,
    enumName: 'PublicErrorCode',
    example: 'INVALID_CREDENTIALS',
  })
  code!: PublicErrorCode;

  @ApiProperty({
    description:
      'Safe human-readable fallback. Its wording is not part of the stable client contract.',
    example: 'Invalid email or password.',
  })
  message!: string;

  @ApiPropertyOptional({
    description:
      'Typed, error-specific context documented by the endpoint response schema.',
    type: 'object',
    additionalProperties: true,
  })
  details?: Record<string, unknown>;
}
