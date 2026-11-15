import { Logger } from '@nestjs/common';

import { AuthenticationOperationTelemetryService } from './authentication-operation-telemetry.service';
import type { AuthenticationOperationTelemetryInput } from '../types/authentication-operation-telemetry.type';

describe('Authentication operation telemetry payload', () => {
  const input: AuthenticationOperationTelemetryInput = {
    operation: 'SIGN_IN_REQUEST',
    outcome: 'CREATED',
    replayed: false,
    durationMs: 1.25,
  };
  afterEach(() => jest.restoreAllMocks());

  it('writes a bounded JSON completion with no per-operation data', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    await new AuthenticationOperationTelemetryService().record({
      ...input,
      email: 'synthetic@example.edu',
      operationId: 'private-id',
      proof: 'private-proof',
    } as AuthenticationOperationTelemetryInput);
    const event = JSON.parse(log.mock.calls[0][0] as string) as Record<
      string,
      unknown
    >;
    expect(event).toEqual({
      event: 'AUTHENTICATION_OPERATION_COMPLETED',
      schemaVersion: 1,
      ...input,
      denial: null,
      deniedPolicyIds: [],
      failureReason: null,
    });
    expect(log.mock.calls[0][0]).not.toMatch(/synthetic|private/);
  });
  it('deduplicates and sorts only the fixed denial policy IDs', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    await new AuthenticationOperationTelemetryService().record({
      ...input,
      outcome: 'DENIED',
      denial: 'RATE_LIMITED',
      deniedPolicyIds: [
        'AUTH_DELIVERY_IP',
        'synthetic@example.edu',
        'AUTH_DELIVERY_IDENTITY',
        'AUTH_DELIVERY_IP',
      ],
    });
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
      deniedPolicyIds: ['AUTH_DELIVERY_IDENTITY', 'AUTH_DELIVERY_IP'],
      denial: 'RATE_LIMITED',
    });
    expect(log.mock.calls[0][0]).not.toContain('synthetic');
  });
  it('does not turn replay into a fresh outcome or report unchecked policies as allowed', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    await new AuthenticationOperationTelemetryService().record({
      ...input,
      replayed: true,
      deniedPolicyIds: ['AUTH_DELIVERY_IP'],
    });
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
      outcome: 'CREATED',
      replayed: true,
      deniedPolicyIds: [],
    });
  });
  it('never serializes unknown category strings or invalid durations', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    await new AuthenticationOperationTelemetryService().record({
      operation: 'private-operation',
      outcome: 'private-outcome',
      replayed: false,
      durationMs: Infinity,
      denial: 'private-denial',
      failureReason: 'private-error',
    } as unknown as AuthenticationOperationTelemetryInput);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
      operation: 'UNKNOWN',
      outcome: 'FAILURE',
      failureReason: 'UNEXPECTED',
      denial: null,
      durationMs: 0,
    });
    expect(log.mock.calls[0][0]).not.toContain('private');
  });
});
