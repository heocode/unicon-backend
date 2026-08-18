import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RequestAccountDeletionDto {
  @ApiProperty({
    example: 'CurrentPassword1!',
    description:
      'Current account password used to re-authenticate the request.',
  })
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;
}
