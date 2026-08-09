import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';

export class UpdateSessionDto {
  @ApiProperty({
    example: 'Personal phone',
    maxLength: 50,
    nullable: true,
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  sessionName!: string | null;
}

export class UpdateSessionResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  id!: string;

  @ApiProperty({ example: 'Personal phone', nullable: true })
  sessionName!: string | null;
}
