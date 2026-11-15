import {
  telemetryFaultFixture,
  telemetryFaults,
} from './telemetry-fault-fixture';

describe('Closed telemetry receiver fault fixture', () => {
  it('allows only the three faults inside the isolated telemetry scenario', () => {
    for (const fault of telemetryFaults)
      expect(
        telemetryFaultFixture(fault, 'telemetry-failure', 'isolated'),
      ).toBe(fault);
  });

  it('rejects unknown faults, other scenarios and retained state', () => {
    for (const fault of ['unknown', 'constructor', '__proto__', ''])
      expect(() =>
        telemetryFaultFixture(fault, 'telemetry-failure', 'isolated'),
      ).toThrow();
    for (const fault of telemetryFaults) {
      expect(() =>
        telemetryFaultFixture(fault, 'mixed-mail', 'isolated'),
      ).toThrow();
      expect(() =>
        telemetryFaultFixture(fault, undefined, 'isolated'),
      ).toThrow();
      expect(() =>
        telemetryFaultFixture(fault, 'telemetry-failure', 'retained'),
      ).toThrow();
    }
  });
});
