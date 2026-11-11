import { isIP } from 'node:net';

import ipaddr from 'ipaddr.js';

/** Canonicalizes one IP literal; source selection and proxy trust belong to HTTP. */
export function canonicalizeIp(value: string | undefined): string {
  // isIP rejects legacy IPv4 syntax and transport syntax accepted by looser
  // parsers. Zone identifiers are outside this single-address contract too.
  if (typeof value !== 'string' || value.includes('%') || isIP(value) === 0) {
    throw new TypeError('Source IP must be a single valid IP literal.');
  }

  // ipaddr.js interprets ::<dotted IPv4> as mapped IPv4. An explicit leading
  // zero group avoids that legacy shortcut and preserves IPv6 address bytes.
  const literal =
    value.startsWith('::') &&
    value.slice(2).includes('.') &&
    !value.slice(2).includes(':')
      ? `0${value}`
      : value;
  const address = ipaddr.parse(literal);

  if (address instanceof ipaddr.IPv6) {
    return address.isIPv4MappedAddress()
      ? address.toIPv4Address().toString()
      : address.toRFC5952String();
  }

  return address.toString();
}
