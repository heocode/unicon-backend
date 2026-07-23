import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  IsNotEmpty,
  IsStrongPassword,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({
    example: 'vadim@my.centennialcollege.ca',
    description: 'University email address.',
  })
  @IsEmail({}, { message: 'Invalid email address.' })
  email!: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'User password.',
  })
  @IsString()
  @IsNotEmpty()
  @IsStrongPassword(
    {
      minLength: 8,
      minUppercase: 1,
      minNumbers: 1,
      minSymbols: 1,
    },
    {
      message:
        'Password must be at least 8 characters long and contain at least one uppercase letter, one number, and one special character.',
    },
  )
  password!: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'Password confirmation.',
  })
  @IsString()
  @IsNotEmpty()
  @IsStrongPassword(
    {
      minLength: 8,
      minUppercase: 1,
      minNumbers: 1,
      minSymbols: 1,
    },
    {
      message:
        'Password must be at least 8 characters long and contain at least one uppercase letter, one number, and one special character.',
    },
  )
  confirmedPassword!: string;
}
