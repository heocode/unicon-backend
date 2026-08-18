import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyEmailDto {
  @ApiProperty({
    description: 'Opaque 64-character token from the verification email.',
  })
  @Transform(({ value }): unknown => {
    const token: unknown = value;
    return typeof token === 'string' ? token.trim() : token;
  })
  @IsString()
  @IsNotEmpty()
  @Length(64, 64)
  token!: string;
}
