import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { AccountDeletionFinalizationService } from '../services/account-deletion-finalization.service';

async function finalizeAccountDeletions(): Promise<void> {
  const logger = new Logger('AccountDeletionFinalizer');
  const application = await NestFactory.createApplicationContext(AppModule);

  try {
    const finalizationService = application.get(
      AccountDeletionFinalizationService,
    );
    const summary = await finalizationService.run();
    logger.log(
      `Finalized ${summary.finalizedAccounts} account(s); retried ${summary.retriedCompletionDeliveries} completion delivery or deliveries.`,
    );
  } finally {
    await application.close();
  }
}

void finalizeAccountDeletions().catch((error: unknown) => {
  const logger = new Logger('AccountDeletionFinalizer');
  logger.error(
    'Account deletion finalization failed.',
    error instanceof Error ? error.stack : undefined,
  );
  process.exitCode = 1;
});
