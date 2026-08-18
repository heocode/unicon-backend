import { ApiProperty } from '@nestjs/swagger';

export class AuthTokensResponseDto {
  @ApiProperty({ description: 'Short-lived access JWT.' })
  accessToken!: string;

  @ApiProperty({ description: 'Rotating session refresh JWT.' })
  refreshToken!: string;
}

export class RegistrationResponseDto {
  @ApiProperty({ example: 'Verification email sent successfully.' })
  message!: string;

  @ApiProperty({ example: 'student@my.centennialcollege.ca' })
  email!: string;

  @ApiProperty({ example: 60, minimum: 0 })
  resendAvailableInSeconds!: number;
}

export class EmailVerificationResponseDto extends AuthTokensResponseDto {
  @ApiProperty({ example: 'Email verified successfully.' })
  message!: string;
}

export class ResendVerificationResponseDto {
  @ApiProperty({ example: 'Verification email sent successfully.' })
  message!: string;
}
