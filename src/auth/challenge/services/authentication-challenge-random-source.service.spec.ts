import { AuthenticationChallengeRandomSourceService } from './authentication-challenge-random-source.service';

describe('AuthenticationChallengeRandomSourceService', () => {
  const service = new AuthenticationChallengeRandomSourceService();

  it('returns an integer inside the requested exclusive upper bound', () => {
    for (let sample = 0; sample < 100; sample += 1) {
      const value = service.randomInteger(1_000_000);

      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1_000_000);
    }
  });

  it('returns the requested number of random bytes', () => {
    expect(service.randomBytes(32)).toHaveLength(32);
  });
});
