import { ApiProperty } from '@nestjs/swagger';

export class AccountDeletionCancelledResponseDto {
  @ApiProperty({ example: 'ACTIVE' })
  status!: 'ACTIVE';

  @ApiProperty({ example: true })
  deletionCancelled!: true;

  @ApiProperty({ description: 'Access JWT for the newly created session.' })
  accessToken!: string;

  @ApiProperty({ description: 'Refresh JWT for the newly created session.' })
  refreshToken!: string;
}
