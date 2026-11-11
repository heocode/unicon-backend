const UINT32_BYTES = 4;
const UINT32_MAX = 0xffff_ffff;

export function encodeLengthPrefixedFields(fields: readonly Buffer[]): Buffer {
  const encodedFields: Buffer[] = [];

  for (const field of fields) {
    if (field.length > UINT32_MAX) {
      throw new RangeError('Length-prefixed field exceeds the uint32 limit.');
    }

    const length = Buffer.allocUnsafe(UINT32_BYTES);
    length.writeUInt32BE(field.length);
    encodedFields.push(length, field);
  }

  return Buffer.concat(encodedFields);
}
