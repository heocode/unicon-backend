import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsStrongPassword,
  Length,
} from 'class-validator';

import {
  PASSWORD_VALIDATION_MESSAGE,
  PASSWORD_VALIDATION_OPTIONS,
} from '../password/constants/password-validation.constants';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Opaque token from the password reset email.' })
  @IsString()
  @Length(64, 64)
  token!: string;

  @ApiProperty({ example: 'NewPassword2!' })
  @IsString()
  @IsNotEmpty()
  @IsStrongPassword(PASSWORD_VALIDATION_OPTIONS, {
    message: PASSWORD_VALIDATION_MESSAGE,
  })
  newPassword!: string;

  @ApiProperty({ example: 'NewPassword2!' })
  @IsString()
  @IsNotEmpty()
  confirmNewPassword!: string;
}
