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

export class PasswordResetTokenInvalidErrorResponseDto {
  @ApiProperty({ example: 'PASSWORD_RESET_TOKEN_INVALID' })
  code!: 'PASSWORD_RESET_TOKEN_INVALID';

  @ApiProperty({ example: 'The password reset token is invalid or expired.' })
  message!: string;
}

export class RateLimitExceededErrorResponseDto {
  @ApiProperty({ example: 'RATE_LIMIT_EXCEEDED' })
  code!: 'RATE_LIMIT_EXCEEDED';

  @ApiProperty({
    example: 'Too many password reset requests. Please try again later.',
  })
  message!: string;

  @ApiProperty({ example: 742 })
  retryAfterSeconds!: number;
}
