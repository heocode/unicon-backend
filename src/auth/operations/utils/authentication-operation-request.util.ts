import { createHash } from 'node:crypto';

import { assertCanonicalUuid } from '../../../common/utils/assert-canonical-uuid.util';
import { canonicalizeIp } from '../../../common/utils/canonicalize-ip.util';
import { encodeLengthPrefixedFields } from '../../../common/utils/encode-length-prefixed-fields.util';
import { AuthenticationOperationError } from '../errors/authentication-operation.error';
import type { AuthenticationOperationRequest } from '../types/authentication-operation.type';
import { authenticationOperationWindow } from './authentication-operation-id.util';

export function captureAuthenticationOperation(
  id: string,
  request: AuthenticationOperationRequest,
) {
  try {
    authenticationOperationWindow(id);
    const ipAddress = canonicalizeIp(request.input.ipAddress);
    const templateProtocolVersion = request.input.templateProtocolVersion;
    if (
      !Number.isSafeInteger(templateProtocolVersion) ||
      templateProtocolVersion <= 0
    )
      throw new Error('Invalid template.');
    let captured: AuthenticationOperationRequest;
    let subject: string;
    let retention = '';
    if (request.kind === 'SIGN_IN_REQUEST') {
      subject = request.input.normalizedIdentity;
      if (
        typeof subject !== 'string' ||
        !subject ||
        subject !== subject.trim() ||
        subject !== subject.toLowerCase() ||
        /\p{Cc}/u.test(subject) ||
        Buffer.from(subject, 'utf8').toString('utf8') !== subject
      )
        throw new Error('Invalid identity.');
      captured = {
        kind: 'SIGN_IN_REQUEST',
        input: {
          normalizedIdentity: subject,
          ipAddress,
          templateProtocolVersion,
        },
      };
    } else if (request.kind === 'RESEND') {
      subject = request.input.challengeId;
      assertCanonicalUuid(subject);
      const retentionExpiresAt = new Date(
        request.input.retentionExpiresAt.getTime(),
      );
      if (!Number.isFinite(retentionExpiresAt.getTime()))
        throw new Error('Invalid retention.');
      retention = retentionExpiresAt.toISOString();
      captured = {
        kind: 'RESEND',
        input: {
          challengeId: subject,
          ipAddress,
          templateProtocolVersion,
          retentionExpiresAt,
        },
      };
    } else throw new Error('Invalid operation kind.');
    // Binding only, not identity proof. Including the random operation ID avoids
    // stable cross-operation fingerprints; this has no rotating key dependency.
    const requestHash = createHash('sha256')
      .update(
        encodeLengthPrefixedFields(
          [
            'unicon.auth.operation.request.v1',
            id,
            captured.kind,
            subject,
            ipAddress,
            String(templateProtocolVersion),
            retention,
          ].map((field) => Buffer.from(field, 'utf8')),
        ),
      )
      .digest();
    return { request: captured, requestHash };
  } catch {
    throw new AuthenticationOperationError('INVALID_INPUT');
  }
}
