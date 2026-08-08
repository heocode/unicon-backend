import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class VerifyEmailDto {
  @Transform(({ value }): unknown => {
    const token: unknown = value;
    return typeof token === 'string' ? token.trim() : token;
  })
  @IsString()
  @IsNotEmpty()
  @Length(64, 64)
  token!: string;
}
