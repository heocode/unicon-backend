import { ApiProperty } from '@nestjs/swagger';

export class AccountDeletionRateLimitErrorResponseDto {
  @ApiProperty({ example: 'RATE_LIMIT_EXCEEDED' })
  code!: 'RATE_LIMIT_EXCEEDED';

  @ApiProperty({
    example:
      'Too many account deletion cancellation attempts. Please try again later.',
  })
  message!: string;

  @ApiProperty({ example: 742 })
  retryAfterSeconds!: number;
}
