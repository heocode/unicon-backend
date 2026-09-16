// NestJS
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

// Internal repositories
import { AuthenticationDeliveryRepository } from '../repositories/authentication-delivery.repository';

// Internal services
import { AuthenticationDeliveryOrchestrationService } from './authentication-delivery-orchestration.service';
import { AuthenticationDeliveryPolicyService } from './authentication-delivery-policy.service';

// Internal types
import {
  AuthenticationDeliveryClaimKind,
  type ClaimedAuthenticationDelivery,
} from '../types/authentication-delivery.type';
import type { AuthenticationDeliveryOrchestrationResult } from '../types/authentication-delivery-orchestration.type';
import type { AuthenticationDeliveryWorkerSummary } from '../types/authentication-delivery-worker.type';

type MutableWorkerSummary = {
  -readonly [
    Key in keyof AuthenticationDeliveryWorkerSummary
  ]: AuthenticationDeliveryWorkerSummary[Key];
};

@Injectable()
export class AuthenticationDeliveryWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    AuthenticationDeliveryWorkerService.name,
  );
  private timer: NodeJS.Timeout | null = null;
  private activeCycle: Promise<AuthenticationDeliveryWorkerSummary> | null =
    null;
  private stopping = false;

  constructor(
    private readonly repository: AuthenticationDeliveryRepository,
    private readonly orchestration: AuthenticationDeliveryOrchestrationService,
    private readonly policy: AuthenticationDeliveryPolicyService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => this.startScheduledCycle(),
      this.policy.workerIntervalSeconds * 1_000,
    );
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.activeCycle;
  }

  runOnce(): Promise<AuthenticationDeliveryWorkerSummary> {
    if (this.activeCycle) {
      return Promise.resolve(this.emptySummary(true));
    }

    this.activeCycle = this.runCycle().finally(() => {
      this.activeCycle = null;
    });
    return this.activeCycle;
  }

  private startScheduledCycle(): void {
    if (this.stopping || this.activeCycle) {
      return;
    }

    void this.runOnce()
      .then((summary) => {
        if (summary.claimedCount > 0 || summary.exhaustedLeaseCount > 0) {
          this.logger.log({
            event: 'AUTHENTICATION_DELIVERY_WORKER_CYCLE_COMPLETED',
            ...summary,
          });
        }
      })
      .catch(() => {
        this.logger.error({
          event: 'AUTHENTICATION_DELIVERY_WORKER_CYCLE_FAILED',
        });
      });
  }

  private async runCycle(): Promise<AuthenticationDeliveryWorkerSummary> {
    const summary = this.emptySummary(false);
    summary.exhaustedLeaseCount =
      await this.repository.terminalizeExpiredExhaustedLeases(
        this.policy.workerExhaustedLeaseBatchSize,
      );

    let claimSlotsReserved = 0;
    let stopClaiming = this.stopping;
    let queueObservedEmpty = false;

    const runLane = async (): Promise<void> => {
      while (!this.stopping && !stopClaiming && !queueObservedEmpty) {
        if (claimSlotsReserved >= this.policy.workerMaxDeliveriesPerCycle) {
          break;
        }

        claimSlotsReserved++;
        let delivery: ClaimedAuthenticationDelivery | null;
        try {
          delivery = await this.repository.claimNextDelivery();
        } catch {
          summary.stoppedByClaimFailure = true;
          stopClaiming = true;
          break;
        }

        if (!delivery) {
          queueObservedEmpty = true;
          break;
        }

        summary.claimedCount++;
        if (delivery.claimKind === AuthenticationDeliveryClaimKind.NORMAL) {
          summary.normalClaimCount++;
        } else {
          summary.reclaimedClaimCount++;
        }

        try {
          const result = await this.orchestration.process(delivery);
          this.recordOutcome(summary, result);
        } catch {
          summary.unexpectedFailureCount++;
          this.logger.error({
            event: 'AUTHENTICATION_DELIVERY_ORCHESTRATION_UNEXPECTED_FAILURE',
            deliveryId: delivery.id,
            challengeId: delivery.challengeId,
            attemptCount: delivery.attemptCount,
            claimKind: delivery.claimKind,
          });
        }
      }
    };

    await Promise.all(
      Array.from({ length: this.policy.workerConcurrency }, async () =>
        runLane(),
      ),
    );

    summary.reachedCycleLimit =
      claimSlotsReserved >= this.policy.workerMaxDeliveriesPerCycle &&
      !queueObservedEmpty;
    return summary;
  }

  private recordOutcome(
    summary: MutableWorkerSummary,
    result: AuthenticationDeliveryOrchestrationResult,
  ): void {
    switch (result.outcome) {
      case 'SENT':
        summary.sentCount++;
        break;
      case 'RETRY_SCHEDULED':
        summary.retryScheduledCount++;
        break;
      case 'FAILED':
        summary.failedCount++;
        break;
      case 'CANCELLED':
        summary.cancelledCount++;
        break;
      case 'LEASE_LOST':
        summary.leaseLostCount++;
        break;
    }
  }

  private emptySummary(skippedAlreadyRunning: boolean): MutableWorkerSummary {
    return {
      claimedCount: 0,
      normalClaimCount: 0,
      reclaimedClaimCount: 0,
      sentCount: 0,
      retryScheduledCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      leaseLostCount: 0,
      unexpectedFailureCount: 0,
      exhaustedLeaseCount: 0,
      stoppedByClaimFailure: false,
      reachedCycleLimit: false,
      skippedAlreadyRunning,
    };
  }
}
