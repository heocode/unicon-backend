import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, IsNotEmpty } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'vadim@my.centennialcollege.ca',
    description: 'University email address.',
  })
  @Transform(({ value }): unknown => {
    const email: unknown = value;
    return typeof email === 'string' ? email.trim().toLowerCase() : email;
  })
  @IsEmail({}, { message: 'Incorrect email.' })
  email!: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'Account password.',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
