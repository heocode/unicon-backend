import { ApiProperty } from '@nestjs/swagger';

export class AccountDeletionResponseDto {
  @ApiProperty({ example: 'DELETION_SCHEDULED' })
  status!: 'DELETION_SCHEDULED';

  @ApiProperty({
    example: '2026-09-16T12:00:00.000Z',
    format: 'date-time',
  })
  deletionScheduledAt!: Date;

  @ApiProperty({ example: 2_592_000, minimum: 1 })
  gracePeriodSeconds!: number;
}
