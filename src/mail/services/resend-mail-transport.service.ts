import { Injectable } from '@nestjs/common';

import type { MailSubmission } from '../types/mail-submission.type';
import type { MailSubmissionGateResult } from '../types/mail-submission-gate.type';
import {
  needsProviderPressure,
  providerRestriction,
} from '../utils/mail-provider-pressure.util';
import { MailProviderPressureService } from './mail-provider-pressure.service';
import { MailSubmissionGateService } from './mail-submission-gate.service';
import {
  ResendMailHttpClient,
  type ResendMailHttpResponse,
} from './resend-mail-http-client.service';

export type ResendMailTransportResult =
  | Exclude<MailSubmissionGateResult, { outcome: 'GRANTED' }>
  | (ResendMailHttpResponse &
      Readonly<{
        pressurePersistence: 'NOT_REQUIRED' | 'RECORDED' | 'FAILED';
        providerRestriction: ReturnType<typeof providerRestriction>;
      }>)
  | Readonly<{
      outcome: 'OUTCOME_UNKNOWN';
      safeFailureCode: 'RESEND_TRANSPORT_OUTCOME_UNKNOWN';
    }>;

@Injectable()
export class ResendMailTransportService {
  constructor(
    private readonly gate: MailSubmissionGateService,
    private readonly http: ResendMailHttpClient,
    private readonly pressure: MailProviderPressureService,
  ) {}

  /** Exactly one attempt. Caller owns deadlines, retry scheduling and durable work.
   * DB locks are released before HTTP. A consumed permission is never refunded. */
  async send(
    submission: MailSubmission,
    signal: AbortSignal,
  ): Promise<ResendMailTransportResult> {
    // An already cancelled caller must not consume a permission or send a request.
    signal.throwIfAborted();
    const permission = await this.gate.tryAcquire();
    if (permission.outcome !== 'GRANTED') return permission;
    let response: ResendMailHttpResponse;
    try {
      response = await this.http.send(submission, signal);
    } catch {
      return {
        outcome: 'OUTCOME_UNKNOWN',
        safeFailureCode: 'RESEND_TRANSPORT_OUTCOME_UNKNOWN',
      };
    }
    const observation = {
      statusCode: response.outcome === 'ACCEPTED' ? 200 : response.statusCode,
      ...(response.outcome === 'REJECTED'
        ? { errorName: response.errorName }
        : {}),
      headers: response.headers,
    };
    const restriction = providerRestriction(observation);
    if (!needsProviderPressure(observation))
      return {
        ...response,
        providerRestriction: restriction,
        pressurePersistence: 'NOT_REQUIRED',
      };
    try {
      await this.pressure.observe(observation);
      return {
        ...response,
        providerRestriction: restriction,
        pressurePersistence: 'RECORDED',
      };
    } catch {
      // Do not erase an ACCEPTED response or imply a safe retry after a DB failure.
      // Caller must surface this technical failure, not treat it as capacity waiting.
      return {
        ...response,
        providerRestriction: restriction,
        pressurePersistence: 'FAILED',
      };
    }
  }
}
