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
