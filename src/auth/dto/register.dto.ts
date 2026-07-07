import { IsEmail, IsString, IsNotEmpty, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'incorrect email' })
  email: string;

  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6, { message: 'password should contain minimum 6 chars' })
  password: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6, { message: 'password should contain minimum 6 chars' })
  confirmedPassword: string;
}
