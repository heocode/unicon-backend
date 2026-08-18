import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class CancelAccountDeletionDto {
  @ApiProperty({
    example: 'student@my.centennialcollege.ca',
    description: 'College email address of the deletion-scheduled account.',
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: 'CurrentPassword1!',
    description:
      'Current account password used to re-authenticate cancellation.',
  })
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;
}
