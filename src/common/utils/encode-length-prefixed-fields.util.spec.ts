import { encodeLengthPrefixedFields } from './encode-length-prefixed-fields.util';

describe('encodeLengthPrefixedFields', () => {
  it('prefixes every field with its uint32 big-endian byte length', () => {
    const encoded = encodeLengthPrefixedFields([
      Buffer.from('ab'),
      Buffer.from('c'),
    ]);

    expect(encoded.toString('hex')).toBe('0000000261620000000163');
  });

  it('uses UTF-8 byte length rather than character count', () => {
    const field = Buffer.from('é', 'utf8');
    const encoded = encodeLengthPrefixedFields([field]);

    expect(encoded.subarray(0, 4).readUInt32BE()).toBe(2);
    expect(encoded.subarray(4)).toEqual(field);
  });

  it('keeps otherwise ambiguous field groupings distinct', () => {
    const first = encodeLengthPrefixedFields([
      Buffer.from('ab'),
      Buffer.from('c'),
    ]);
    const second = encodeLengthPrefixedFields([
      Buffer.from('a'),
      Buffer.from('bc'),
    ]);

    expect(first).not.toEqual(second);
  });

  it('does not mutate input buffers', () => {
    const field = Buffer.from('proof');
    const original = Buffer.from(field);

    encodeLengthPrefixedFields([field]);

    expect(field).toEqual(original);
  });
});
