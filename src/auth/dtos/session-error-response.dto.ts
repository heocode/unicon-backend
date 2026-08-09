import { ApiProperty } from '@nestjs/swagger';

export class SessionTooFreshErrorResponseDto {
  @ApiProperty({ example: 'SESSION_TOO_FRESH' })
  code!: 'SESSION_TOO_FRESH';

  @ApiProperty({ example: 'This session is too new to manage sessions.' })
  message!: string;

  @ApiProperty({
    example: '2026-08-10T02:06:56.901Z',
    format: 'date-time',
  })
  managementAvailableAt!: Date;

  @ApiProperty({ example: 86_400, minimum: 1 })
  retryAfterSeconds!: number;
}

export class SessionNotFoundErrorResponseDto {
  @ApiProperty({ example: 'SESSION_NOT_FOUND' })
  code!: 'SESSION_NOT_FOUND';

  @ApiProperty({ example: 'Active session not found.' })
  message!: string;
}

export class SessionLimitReachedErrorResponseDto {
  @ApiProperty({ example: 'SESSION_LIMIT_REACHED' })
  code!: 'SESSION_LIMIT_REACHED';

  @ApiProperty({ example: 'The active session limit has been reached.' })
  message!: string;

  @ApiProperty({ example: 10, minimum: 1 })
  activeSessionLimit!: number;
}

export class UnauthorizedErrorResponseDto {
  @ApiProperty({ example: 401 })
  statusCode!: number;

  @ApiProperty({ example: 'Access Denied. Session unavailable.' })
  message!: string;

  @ApiProperty({ example: 'Unauthorized' })
  error!: string;
}

export class ValidationErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({
    example: ['sessionId must be a UUID'],
    isArray: true,
    type: String,
  })
  message!: string[];

  @ApiProperty({ example: 'Bad Request' })
  error!: string;
}
