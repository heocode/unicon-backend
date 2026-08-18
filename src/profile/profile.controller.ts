// NestJS
import { Controller, Get, HttpStatus, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

// Internal services
import { ProfileQueryService } from './services/profile-query.service';

// Internal guards
import { AccessTokenGuard } from '../auth/guards/access-token.guard';

// Internal DTOs
import { ProfileResponseDto } from './dtos/profile-response.dto';
import { ApiPublicErrorResponse } from '../swagger/common/public-error-response.decorator';

// Internal types
import type { AccessAuthenticatedRequest } from '../auth/types/authenticated-request.type';

@ApiTags('Profile')
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileQueryService: ProfileQueryService) {}

  @Get('me')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get the authenticated user profile' })
  @ApiOkResponse({
    description: 'The authenticated user profile.',
    type: ProfileResponseDto,
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.UNAUTHORIZED,
    codes: [
      'ACCESS_TOKEN_REQUIRED',
      'ACCESS_TOKEN_INVALID',
      'ACCESS_TOKEN_EXPIRED',
      'SESSION_UNAVAILABLE',
    ],
    description: 'The access credential or session is unavailable.',
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.CONFLICT,
    codes: ['PROFILE_UNAVAILABLE'],
    description: 'The profile became unavailable during the request.',
  })
  getMe(
    @Req() request: AccessAuthenticatedRequest,
  ): Promise<ProfileResponseDto> {
    return this.profileQueryService.findMe(request.user.sub);
  }
}
