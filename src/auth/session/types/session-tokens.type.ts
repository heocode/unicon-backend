export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

export type CreatedSession = AuthTokens & {
  sessionId: string;
};
