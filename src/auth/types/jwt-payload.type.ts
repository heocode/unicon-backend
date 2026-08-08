type BaseTokenPayload = {
  sub: string;
  sessionId: string;
  exp?: number;
};

export type AccessTokenPayload = BaseTokenPayload & {
  tokenType: 'access';
};

export type RefreshTokenPayload = BaseTokenPayload & {
  tokenType: 'refresh';
};
