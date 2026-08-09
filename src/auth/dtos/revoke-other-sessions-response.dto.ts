import { ApiProperty } from '@nestjs/swagger';

export class RevokeOtherSessionsResponseDto {
  @ApiProperty({ example: 3, minimum: 0 })
  revokedSessionsCount!: number;
}
