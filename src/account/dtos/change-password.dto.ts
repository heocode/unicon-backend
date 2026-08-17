import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsStrongPassword } from 'class-validator';

import {
  PASSWORD_VALIDATION_MESSAGE,
  PASSWORD_VALIDATION_OPTIONS,
} from '../../auth/password/constants/password-validation.constants';

export class ChangePasswordDto {
  @ApiProperty({
    example: 'CurrentPassword1!',
    description: 'Current account password.',
  })
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @ApiProperty({
    example: 'NewPassword2!',
    description: 'New account password.',
  })
  @IsString()
  @IsNotEmpty()
  @IsStrongPassword(PASSWORD_VALIDATION_OPTIONS, {
    message: PASSWORD_VALIDATION_MESSAGE,
  })
  newPassword!: string;

  @ApiProperty({
    example: 'NewPassword2!',
    description: 'New account password confirmation.',
  })
  @IsString()
  @IsNotEmpty()
  confirmNewPassword!: string;
}
