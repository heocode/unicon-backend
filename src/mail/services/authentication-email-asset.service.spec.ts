// Node.js
import { createHash } from 'node:crypto';

// Internal constants
import {
  AUTHENTICATION_EMAIL_LOGO_V1_MAX_BYTES,
  AUTHENTICATION_EMAIL_LOGO_V1_SHA256,
} from '../../config/constants/authentication-email.constants';
import { AuthenticationEmailAssetService } from './authentication-email-asset.service';

describe('AuthenticationEmailAssetService', () => {
  it('loads the immutable versioned PNG contract', () => {
    const content = new AuthenticationEmailAssetService().getLogoV1();

    expect(content.byteLength).toBeGreaterThan(0);
    expect(content.byteLength).toBeLessThanOrEqual(
      AUTHENTICATION_EMAIL_LOGO_V1_MAX_BYTES,
    );
    expect(Buffer.from(content).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(createHash('sha256').update(content).digest('hex')).toBe(
      AUTHENTICATION_EMAIL_LOGO_V1_SHA256,
    );
  });

  it('does not expose the cached bytes to mutation', () => {
    const service = new AuthenticationEmailAssetService();
    const first = service.getLogoV1();
    const expectedFirstByte = first[0];

    first[0] = 0;

    expect(service.getLogoV1()[0]).toBe(expectedFirstByte);
  });
});
