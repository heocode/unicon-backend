// NestJS
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
  ApiTags,
} from '@nestjs/swagger';

// Internal services
import { ProfileQueryService } from './services/profile-query.service';

// Internal guards
import { AccessTokenGuard } from '../auth/guards/access-token.guard';

// Internal DTOs
import { ProfileResponseDto } from './dtos/profile-response.dto';
import { UnauthorizedErrorResponseDto } from '../auth/dtos/session-error-response.dto';

// Internal types
import type { AccessAuthenticatedRequest } from '../auth/types/authenticated-request.type';

@ApiTags('Profile')
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileQueryService: ProfileQueryService) {}

  @Get('me')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the authenticated user profile' })
  @ApiOkResponse({
    description: 'The authenticated user profile.',
    type: ProfileResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'The user is not authorized or the profile is unavailable.',
    type: UnauthorizedErrorResponseDto,
  })
  getMe(
    @Req() request: AccessAuthenticatedRequest,
  ): Promise<ProfileResponseDto> {
    return this.profileQueryService.findMe(request.user.sub);
  }
}
