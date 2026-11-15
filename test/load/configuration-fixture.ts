// Closed, test-only profiles. These are not deployment settings or a tuning API.
export const configurationProfiles = {
  baseline: {
    AUTH_DELIVERY_IP_BURST: 3,
    AUTH_DELIVERY_IP_RATE: 1,
    AUTH_DELIVERY_IP_PERIOD_SECONDS: 3600,
  },
  burst: {
    AUTH_DELIVERY_IP_BURST: 4,
    AUTH_DELIVERY_IP_RATE: 1,
    AUTH_DELIVERY_IP_PERIOD_SECONDS: 3600,
  },
  rate: {
    AUTH_DELIVERY_IP_BURST: 3,
    AUTH_DELIVERY_IP_RATE: 2,
    AUTH_DELIVERY_IP_PERIOD_SECONDS: 3600,
  },
  period: {
    AUTH_DELIVERY_IP_BURST: 3,
    AUTH_DELIVERY_IP_RATE: 1,
    AUTH_DELIVERY_IP_PERIOD_SECONDS: 7200,
  },
} as const;

export type ConfigurationProfile = keyof typeof configurationProfiles;

export function configurationFixture(
  profile: string,
  scenario: string | undefined,
  stateMode: string,
) {
  if (
    scenario !== 'config-mismatch' ||
    stateMode !== 'isolated' ||
    !Object.hasOwn(configurationProfiles, profile)
  )
    throw new Error('Invalid isolated configuration fixture.');
  return configurationProfiles[profile as ConfigurationProfile];
}
