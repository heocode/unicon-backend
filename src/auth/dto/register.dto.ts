import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsNotEmpty, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({
    example: 'vadim@my.centennialcollege.ca',
    description: 'University email address.',
  })
  @IsEmail({}, { message: 'Invalid email address.' })
  email: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'User password.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(6, {
    message: 'Password should contain at least 6 characters.',
  })
  password: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'Password confirmation.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(6, {
    message: 'Password should contain at least 6 characters.',
  })
  confirmedPassword: string;
}
