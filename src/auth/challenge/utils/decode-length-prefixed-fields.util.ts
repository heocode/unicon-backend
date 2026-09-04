const UINT32_BYTES = 4;

export function decodeLengthPrefixedFields(
  encoded: Buffer,
  expectedFieldCount: number,
): Buffer[] {
  const fields: Buffer[] = [];
  let offset = 0;

  for (let index = 0; index < expectedFieldCount; index += 1) {
    if (encoded.length - offset < UINT32_BYTES) {
      throw new RangeError('Length-prefixed field header is truncated.');
    }

    const fieldLength = encoded.readUInt32BE(offset);
    offset += UINT32_BYTES;

    if (encoded.length - offset < fieldLength) {
      throw new RangeError('Length-prefixed field value is truncated.');
    }

    fields.push(Buffer.from(encoded.subarray(offset, offset + fieldLength)));
    offset += fieldLength;
  }

  if (offset !== encoded.length) {
    throw new RangeError('Length-prefixed payload contains trailing bytes.');
  }

  return fields;
}
