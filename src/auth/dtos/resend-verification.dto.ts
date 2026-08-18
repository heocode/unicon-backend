import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResendVerificationDto {
  @ApiProperty({ example: 'student@my.centennialcollege.ca' })
  @Transform(({ value }): unknown => {
    const email: unknown = value;
    return typeof email === 'string' ? email.trim().toLowerCase() : email;
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;
}
