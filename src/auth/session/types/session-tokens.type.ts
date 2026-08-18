import type { Prisma } from '../../../generated/prisma/client';

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

export type CreatedSession = AuthTokens & {
  sessionId: string;
};

export type PreparedSession = {
  result: CreatedSession;
  data: Prisma.SessionUncheckedCreateInput;
  occurredAt: Date;
};

export type SessionCreationResult = {
  created: boolean;
};
