import { ApiProperty } from '@nestjs/swagger';

export class AccountDeletionScheduledLoginErrorResponseDto {
  @ApiProperty({ example: 'ACCOUNT_DELETION_SCHEDULED' })
  code!: 'ACCOUNT_DELETION_SCHEDULED';

  @ApiProperty({ example: 'Account deletion is scheduled.' })
  message!: string;

  @ApiProperty({
    example: '2026-09-16T12:00:00.000Z',
    format: 'date-time',
  })
  deletionScheduledAt!: Date;

  @ApiProperty({ example: true })
  canCancel!: true;
}

export class AccountDeletionGracePeriodExpiredLoginErrorResponseDto {
  @ApiProperty({ example: 'ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED' })
  code!: 'ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED';

  @ApiProperty({
    example: 'The account deletion grace period has expired.',
  })
  message!: string;

  @ApiProperty({
    example: '2026-09-16T12:00:00.000Z',
    format: 'date-time',
  })
  deletionScheduledAt!: Date;

  @ApiProperty({ example: false })
  canCancel!: false;
}
