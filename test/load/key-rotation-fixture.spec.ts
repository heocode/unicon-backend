import { keyRotationFixture } from './key-rotation-fixture';

describe('Closed retained-key rotation fixture', () => {
  it('keeps v1 material stable and promotes only after adding the retained key', () => {
    const old = keyRotationFixture('old', 'key-rotation', 'isolated');
    const retained = keyRotationFixture('retained', 'key-rotation', 'isolated');
    const promoted = keyRotationFixture('promoted', 'key-rotation', 'isolated');
    expect([...old.keys.keys()]).toEqual([1]);
    expect([...retained.keys.keys()]).toEqual([1, 2]);
    expect([...promoted.keys.keys()]).toEqual([1, 2]);
    expect([
      old.activeVersion,
      retained.activeVersion,
      promoted.activeVersion,
    ]).toEqual([1, 1, 2]);
    expect(old.keys.get(1)).toEqual(Buffer.alloc(32, 4));
    expect(retained.keys.get(1)).toEqual(old.keys.get(1));
    expect(promoted.keys.get(1)).toEqual(old.keys.get(1));
    expect(promoted.keys.get(2)).toEqual(retained.keys.get(2));
    expect(retained.keys.get(2)).not.toEqual(retained.keys.get(1));
  });
  it('rejects retirement, unknown profiles, other scenarios and retained databases', () => {
    for (const profile of ['retired', 'constructor', '__proto__', 'unknown'])
      expect(() =>
        keyRotationFixture(profile, 'key-rotation', 'isolated'),
      ).toThrow();
    expect(() =>
      keyRotationFixture('old', 'config-mismatch', 'isolated'),
    ).toThrow();
    expect(() =>
      keyRotationFixture('old', 'key-rotation', 'retained'),
    ).toThrow();
  });
});
