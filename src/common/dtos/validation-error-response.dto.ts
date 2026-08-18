import { ApiProperty } from '@nestjs/swagger';

import {
  VALIDATION_VIOLATION_CODES,
  type ValidationViolationCode,
} from '../types/public-error-code.type';

export class ValidationViolationDto {
  @ApiProperty({
    description: 'Stable request field path, including nested and array paths.',
    example: 'email',
  })
  field!: string;

  @ApiProperty({
    description: 'Stable machine-readable validation violation code.',
    enum: VALIDATION_VIOLATION_CODES,
    enumName: 'ValidationViolationCode',
    example: 'INVALID_EMAIL',
  })
  code!: ValidationViolationCode;

  @ApiProperty({
    description:
      'Safe human-readable fallback. Its wording is not part of the stable client contract.',
    example: 'Email must be a valid email address.',
  })
  message!: string;
}

export class ValidationErrorDetailsDto {
  @ApiProperty({ type: ValidationViolationDto, isArray: true })
  violations!: ValidationViolationDto[];
}

export class ValidationErrorResponseDto {
  @ApiProperty({ example: 'VALIDATION_FAILED' })
  code!: 'VALIDATION_FAILED';

  @ApiProperty({ example: 'The request is invalid.' })
  message!: string;

  @ApiProperty({ type: ValidationErrorDetailsDto })
  details!: ValidationErrorDetailsDto;
}
