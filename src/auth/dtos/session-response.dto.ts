import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SessionPlatform } from '../../generated/prisma/client';

export class SessionDeviceResponseDto {
  @ApiPropertyOptional({ example: 'iPhone 16 Pro', nullable: true })
  model!: string | null;

  @ApiProperty({ enum: SessionPlatform, example: SessionPlatform.IOS })
  platform!: SessionPlatform;

  @ApiPropertyOptional({ example: '18.6', nullable: true })
  osVersion!: string | null;
}

export class SessionLocationResponseDto {
  @ApiProperty({ example: 'CA' })
  countryCode!: string;

  @ApiPropertyOptional({ example: 'Toronto', nullable: true })
  city!: string | null;
}

export class SessionResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  id!: string;

  @ApiPropertyOptional({ example: 'Personal phone', nullable: true })
  sessionName!: string | null;

  @ApiProperty({ type: SessionDeviceResponseDto })
  device!: SessionDeviceResponseDto;

  @ApiPropertyOptional({ example: '1.4.2', nullable: true })
  appVersion!: string | null;

  @ApiPropertyOptional({ type: SessionLocationResponseDto, nullable: true })
  location!: SessionLocationResponseDto | null;

  @ApiPropertyOptional({ example: 'Unicon/1.4.2 (iOS 18.6)', nullable: true })
  userAgent!: string | null;

  @ApiPropertyOptional({ example: '192.0.2.10', nullable: true })
  ipAddress!: string | null;

  @ApiProperty({ example: '2026-08-08T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-08-08T14:30:00.000Z' })
  lastActiveAt!: Date;

  @ApiProperty({ example: '2027-08-08T12:00:00.000Z' })
  expiresAt!: Date;

  @ApiProperty({ example: true })
  current!: boolean;
}

export class SessionsResponseDto {
  @ApiProperty({ type: SessionResponseDto, isArray: true })
  sessions!: SessionResponseDto[];
}
