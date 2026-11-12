-- Commit the enum extension before the following migration references it.
ALTER TYPE "AuthenticationOperationDenial" ADD VALUE 'GLOBAL_RATE_DENIED';
