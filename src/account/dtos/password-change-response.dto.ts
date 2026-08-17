import { ApiProperty } from '@nestjs/swagger';

export class PasswordChangeResponseDto {
  @ApiProperty({ example: 'Password changed successfully.' })
  message!: string;

  @ApiProperty({ example: 2, minimum: 0 })
  revokedSessionsCount!: number;
}
