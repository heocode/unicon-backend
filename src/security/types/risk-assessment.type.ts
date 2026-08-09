// Prisma
import type {
  SecurityRiskLevel,
  SecurityRiskSignal,
} from '../../generated/prisma/client';

export type RiskAssessment = {
  level: SecurityRiskLevel | null;
  signals: SecurityRiskSignal[];
};
