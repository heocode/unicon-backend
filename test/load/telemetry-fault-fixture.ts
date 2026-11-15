export const telemetryFaults = ['throw', 'reject', 'pending'] as const;
export type TelemetryFault = (typeof telemetryFaults)[number];

export function telemetryFaultFixture(
  value: string,
  scenario: string | undefined,
  stateMode: string,
): TelemetryFault {
  if (
    scenario !== 'telemetry-failure' ||
    stateMode !== 'isolated' ||
    !telemetryFaults.includes(value as TelemetryFault)
  )
    throw new Error('Invalid isolated telemetry fault fixture.');
  return value as TelemetryFault;
}
