import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsNotEmpty,
  IsStrongPassword,
} from 'class-validator';

import {
  PASSWORD_VALIDATION_MESSAGE,
  PASSWORD_VALIDATION_OPTIONS,
} from '../password/constants/password-validation.constants';

export class RegisterDto {
  @ApiProperty({
    example: 'vadim@my.centennialcollege.ca',
    description: 'University email address.',
  })
  @Transform(({ value }): unknown => {
    const email: unknown = value;
    return typeof email === 'string' ? email.trim().toLowerCase() : email;
  })
  @IsEmail({}, { message: 'Invalid email address.' })
  email!: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'User password.',
  })
  @IsString()
  @IsNotEmpty()
  @IsStrongPassword(PASSWORD_VALIDATION_OPTIONS, {
    message: PASSWORD_VALIDATION_MESSAGE,
  })
  password!: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'Password confirmation.',
  })
  @IsString()
  @IsNotEmpty()
  confirmedPassword!: string;
}
