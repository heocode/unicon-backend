// Public synthetic key material, confined to this isolated test scenario.
export const keyRotationProfiles = {
  old: { activeVersion: 1, versions: [1] },
  retained: { activeVersion: 1, versions: [1, 2] },
  promoted: { activeVersion: 2, versions: [1, 2] },
} as const;
export type KeyRotationProfile = keyof typeof keyRotationProfiles;

export function keyRotationFixture(
  profile: string,
  scenario: string | undefined,
  stateMode: string,
) {
  if (
    scenario !== 'key-rotation' ||
    stateMode !== 'isolated' ||
    !Object.hasOwn(keyRotationProfiles, profile)
  )
    throw new Error('Invalid isolated key-rotation fixture.');
  const selected = keyRotationProfiles[profile as KeyRotationProfile];
  const versions: readonly number[] = selected.versions;
  return {
    activeVersion: selected.activeVersion,
    keys: new Map<number, Buffer>(
      versions.map(
        (version) =>
          [version, Buffer.alloc(32, version === 1 ? 4 : 5)] as const,
      ),
    ),
  };
}
