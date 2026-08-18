import { ApiProperty } from '@nestjs/swagger';

export class RateLimitErrorDetailsDto {
  @ApiProperty({ example: 742, minimum: 1 })
  retryAfterSeconds!: number;
}

export class SessionTooFreshErrorDetailsDto extends RateLimitErrorDetailsDto {
  @ApiProperty({
    example: '2026-08-18T12:00:00.000Z',
    format: 'date-time',
  })
  managementAvailableAt!: Date;
}

export class SessionLimitErrorDetailsDto {
  @ApiProperty({ example: 10, minimum: 1 })
  activeSessionLimit!: number;
}

export class EmailNotVerifiedErrorDetailsDto {
  @ApiProperty({ example: 'student@my.centennialcollege.ca' })
  email!: string;

  @ApiProperty({ example: 42, minimum: 0 })
  resendAvailableInSeconds!: number;
}

export class AccountDeletionLoginErrorDetailsDto {
  @ApiProperty({
    example: '2026-09-16T12:00:00.000Z',
    format: 'date-time',
  })
  deletionScheduledAt!: Date;

  @ApiProperty({ example: true })
  canCancel!: boolean;
}
