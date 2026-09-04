import {
  AUTHENTICATION_CHALLENGE_ENVELOPE_AAD_DOMAIN,
  AUTHENTICATION_CHALLENGE_ENVELOPE_PAYLOAD_DOMAIN,
  MAGIC_LINK_SECRET_BYTES,
} from '../constants/challenge-proof.constants';
import type {
  ChallengeProofContext,
  TransientChallengeDeliveryProof,
} from '../types/challenge-proof.type';
import { assertCanonicalChallengeProofContext } from './assert-canonical-challenge-proof-context.util';
import { decodeLengthPrefixedFields } from './decode-length-prefixed-fields.util';
import { encodeLengthPrefixedFields } from './encode-length-prefixed-fields.util';
import {
  parseCanonicalMagicLinkToken,
  parseCanonicalOtp,
} from './parse-canonical-challenge-proof.util';

const PAYLOAD_FIELD_COUNT = 3;

export function encodeAuthenticationChallengeEnvelopePayloadV1(
  proof: TransientChallengeDeliveryProof,
): Buffer {
  return encodeLengthPrefixedFields([
    Buffer.from(AUTHENTICATION_CHALLENGE_ENVELOPE_PAYLOAD_DOMAIN, 'utf8'),
    parseCanonicalOtp(proof.otp),
    parseCanonicalMagicLinkToken(proof.linkToken),
  ]);
}

export function decodeAuthenticationChallengeEnvelopePayloadV1(
  payload: Buffer,
): TransientChallengeDeliveryProof {
  const [domain, otpBytes, linkSecret] = decodeLengthPrefixedFields(
    payload,
    PAYLOAD_FIELD_COUNT,
  );

  if (
    domain.toString('utf8') !==
      AUTHENTICATION_CHALLENGE_ENVELOPE_PAYLOAD_DOMAIN ||
    linkSecret.length !== MAGIC_LINK_SECRET_BYTES
  ) {
    throw new TypeError(
      'Authentication challenge envelope payload is invalid.',
    );
  }

  const otp = otpBytes.toString('ascii');
  parseCanonicalOtp(otp);

  const linkToken = linkSecret.toString('base64url');
  parseCanonicalMagicLinkToken(linkToken);

  return { otp, linkToken };
}

export function encodeAuthenticationChallengeEnvelopeAadV1(
  context: ChallengeProofContext,
): Buffer {
  assertCanonicalChallengeProofContext(context);

  return encodeLengthPrefixedFields([
    Buffer.from(AUTHENTICATION_CHALLENGE_ENVELOPE_AAD_DOMAIN, 'utf8'),
    Buffer.from(context.purpose, 'utf8'),
    Buffer.from(context.challengeId, 'utf8'),
    Buffer.from(context.normalizedIdentity, 'utf8'),
  ]);
}
