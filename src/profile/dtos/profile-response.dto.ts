import { ApiProperty } from '@nestjs/swagger';

import { UserRole } from '../../generated/prisma/client';

export class ProfileUniversityResponseDto {
  @ApiProperty({ example: 'cm1234567890' })
  id!: string;

  @ApiProperty({ example: 'Centennial College' })
  name!: string;
}

export class ProfileResponseDto {
  @ApiProperty({ example: 'cm1234567890' })
  id!: string;

  @ApiProperty({ example: 'student' })
  username!: string;

  @ApiProperty({ example: 'student@my.centennialcollege.ca' })
  email!: string;

  @ApiProperty({ example: true })
  emailVerified!: boolean;

  @ApiProperty({ enum: UserRole, example: UserRole.MEMBER })
  role!: UserRole;

  @ApiProperty({ example: '2026-08-16T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ type: ProfileUniversityResponseDto })
  university!: ProfileUniversityResponseDto;
}
