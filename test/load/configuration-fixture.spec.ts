import {
  configurationFixture,
  configurationProfiles,
} from './configuration-fixture';

describe('Closed configuration mismatch fixtures', () => {
  it('changes exactly one IP-policy field in each incompatible profile', () => {
    const baseline = configurationProfiles.baseline;
    const fields = {
      burst: 'AUTH_DELIVERY_IP_BURST',
      rate: 'AUTH_DELIVERY_IP_RATE',
      period: 'AUTH_DELIVERY_IP_PERIOD_SECONDS',
    } as const;
    for (const profile of ['burst', 'rate', 'period'] as const) {
      const values = configurationFixture(
        profile,
        'config-mismatch',
        'isolated',
      );
      expect(Object.keys(values)).toEqual(Object.keys(baseline));
      const differences = Object.entries(values).filter(
        ([key, value]) => value !== baseline[key as keyof typeof baseline],
      );
      expect(differences.map(([key]) => key)).toEqual([fields[profile]]);
      expect(
        Object.values(values).every(
          (value) => Number.isSafeInteger(value) && value > 0,
        ),
      ).toBe(true);
    }
  });
  it('rejects unknown profiles, unrelated scenarios and retained state', () => {
    for (const value of ['unknown', 'constructor', '__proto__', 'baseline '])
      expect(() =>
        configurationFixture(value, 'config-mismatch', 'isolated'),
      ).toThrow();
    expect(() =>
      configurationFixture('baseline', 'shared-ip', 'isolated'),
    ).toThrow();
    expect(() =>
      configurationFixture('baseline', 'config-mismatch', 'retained'),
    ).toThrow();
  });
});
