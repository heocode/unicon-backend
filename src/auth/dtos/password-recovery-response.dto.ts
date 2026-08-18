import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordResponseDto {
  @ApiProperty({
    example:
      'If an eligible account exists, password reset instructions will be sent.',
  })
  message!: string;
}

export class ResetPasswordResponseDto {
  @ApiProperty({ example: 'Password reset successfully.' })
  message!: string;

  @ApiProperty({ example: 3 })
  revokedSessionsCount!: number;
}
