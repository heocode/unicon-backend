import { AuthenticationChallengePurpose } from '../../../generated/prisma/enums';

import type {
  ChallengeProofContext,
  TransientChallengeDeliveryProof,
} from '../types/challenge-proof.type';
import { encodeLengthPrefixedFields } from './encode-length-prefixed-fields.util';
import {
  decodeAuthenticationChallengeEnvelopePayloadV1,
  encodeAuthenticationChallengeEnvelopeAadV1,
  encodeAuthenticationChallengeEnvelopePayloadV1,
} from './authentication-challenge-envelope-v1.util';

describe('authentication challenge envelope protocol v1', () => {
  const context: ChallengeProofContext = {
    challengeId: '123e4567-e89b-42d3-a456-426614174000',
    purpose: AuthenticationChallengePurpose.SIGN_IN,
    normalizedIdentity: 'student@example.edu',
  };
  const proof: TransientChallengeDeliveryProof = {
    otp: '004201',
    linkToken: Buffer.from(
      Array.from({ length: 32 }, (_, index) => index),
    ).toString('base64url'),
  };

  it('locks the immutable payload and AAD encodings', () => {
    expect(
      encodeAuthenticationChallengeEnvelopePayloadV1(proof).toString('hex'),
    ).toBe(
      '00000029756e69636f6e2e617574682e6368616c6c656e67652e656e76656c6f70652e7061796c6f61642e76310000000630303432303100000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    expect(
      encodeAuthenticationChallengeEnvelopeAadV1(context).toString('hex'),
    ).toBe(
      '00000025756e69636f6e2e617574682e6368616c6c656e67652e656e76656c6f70652e6161642e7631000000075349474e5f494e0000002431323365343536372d653839622d343264332d613435362d3432363631343137343030300000001373747564656e74406578616d706c652e656475',
    );
  });

  it('round-trips the canonical transient proof', () => {
    const payload = encodeAuthenticationChallengeEnvelopePayloadV1(proof);

    expect(decodeAuthenticationChallengeEnvelopePayloadV1(payload)).toEqual(
      proof,
    );
  });

  it.each([
    encodeLengthPrefixedFields([
      Buffer.from('wrong-domain'),
      Buffer.from(proof.otp),
      Buffer.alloc(32),
    ]),
    encodeLengthPrefixedFields([
      Buffer.from('unicon.auth.challenge.envelope.payload.v1'),
      Buffer.from('4201'),
      Buffer.alloc(32),
    ]),
    encodeLengthPrefixedFields([
      Buffer.from('unicon.auth.challenge.envelope.payload.v1'),
      Buffer.from(proof.otp),
      Buffer.alloc(31),
    ]),
  ])('rejects a malformed payload', (payload) => {
    expect(() =>
      decodeAuthenticationChallengeEnvelopePayloadV1(payload),
    ).toThrow();
  });

  it('rejects truncated and trailing payload bytes', () => {
    const payload = encodeAuthenticationChallengeEnvelopePayloadV1(proof);

    expect(() =>
      decodeAuthenticationChallengeEnvelopePayloadV1(payload.subarray(0, -1)),
    ).toThrow('Length-prefixed field value is truncated.');
    expect(() =>
      decodeAuthenticationChallengeEnvelopePayloadV1(
        Buffer.concat([payload, Buffer.from([0])]),
      ),
    ).toThrow('Length-prefixed payload contains trailing bytes.');
  });
});
