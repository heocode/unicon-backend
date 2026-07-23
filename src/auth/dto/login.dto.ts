import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsNotEmpty } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'vadim@my.centennialcollege.ca',
    description: 'University email address.',
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
