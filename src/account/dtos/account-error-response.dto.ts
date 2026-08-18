import { ApiProperty } from '@nestjs/swagger';

export class CurrentPasswordInvalidErrorResponseDto {
  @ApiProperty({ example: 'CURRENT_PASSWORD_INVALID' })
  code!: 'CURRENT_PASSWORD_INVALID';

  @ApiProperty({ example: 'The current password is invalid.' })
  message!: string;
}

export class PasswordsDoNotMatchErrorResponseDto {
  @ApiProperty({ example: 'PASSWORDS_DO_NOT_MATCH' })
  code!: 'PASSWORDS_DO_NOT_MATCH';

  @ApiProperty({ example: 'The new passwords do not match.' })
  message!: string;
}

export class NewPasswordSameAsCurrentErrorResponseDto {
  @ApiProperty({ example: 'NEW_PASSWORD_SAME_AS_CURRENT' })
  code!: 'NEW_PASSWORD_SAME_AS_CURRENT';

  @ApiProperty({
    example: 'The new password must differ from the current password.',
  })
  message!: string;
}

export class PasswordChangedConcurrentlyErrorResponseDto {
  @ApiProperty({ example: 'PASSWORD_CHANGED_CONCURRENTLY' })
  code!: 'PASSWORD_CHANGED_CONCURRENTLY';

  @ApiProperty({ example: 'The password was changed by another request.' })
  message!: string;
}

export class AccountUnavailableErrorResponseDto {
  @ApiProperty({ example: 'ACCOUNT_UNAVAILABLE' })
  code!: 'ACCOUNT_UNAVAILABLE';

  @ApiProperty({ example: 'The account is unavailable.' })
  message!: string;
}

export class SessionUnavailableErrorResponseDto {
  @ApiProperty({ example: 'SESSION_UNAVAILABLE' })
  code!: 'SESSION_UNAVAILABLE';

  @ApiProperty({ example: 'The current session is unavailable.' })
  message!: string;
}

export class AccountStateChangedErrorResponseDto {
  @ApiProperty({ example: 'ACCOUNT_STATE_CHANGED' })
  code!: 'ACCOUNT_STATE_CHANGED';

  @ApiProperty({
    example: 'The account state changed while processing the request.',
  })
  message!: string;
}

export class InvalidCredentialsErrorResponseDto {
  @ApiProperty({ example: 'INVALID_CREDENTIALS' })
  code!: 'INVALID_CREDENTIALS';

  @ApiProperty({ example: 'Invalid email or password.' })
  message!: string;
}

export class AccountDeletionAlreadyCancelledErrorResponseDto {
  @ApiProperty({ example: 'ACCOUNT_DELETION_ALREADY_CANCELLED' })
  code!: 'ACCOUNT_DELETION_ALREADY_CANCELLED';

  @ApiProperty({
    example: 'Account deletion has already been cancelled. Please sign in.',
  })
  message!: string;
}

export class AccountDeletionGracePeriodExpiredErrorResponseDto {
  @ApiProperty({ example: 'ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED' })
  code!: 'ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED';

  @ApiProperty({
    example: 'The account deletion grace period has expired.',
  })
  message!: string;
}
