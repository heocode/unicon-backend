// Express
import { Request } from 'express';

// Internal types
import { AccessTokenPayload, RefreshTokenPayload } from './jwt-payload.type';

export type AccessAuthenticatedRequest = Request & {
  user: AccessTokenPayload;
};

export type RefreshAuthenticatedRequest = Request & {
  user: RefreshTokenPayload;
  refreshToken: string;
};
