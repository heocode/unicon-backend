import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class ResendVerificationDto {
  @Transform(({ value }): unknown => {
    const email: unknown = value;
    return typeof email === 'string' ? email.trim().toLowerCase() : email;
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;
}
