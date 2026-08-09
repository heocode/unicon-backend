import ipaddr from 'ipaddr.js';

export function normalizePublicIp(value: string | undefined): string | null {
  const candidate = value?.trim();

  if (!candidate || !ipaddr.isValid(candidate)) {
    return null;
  }

  let address = ipaddr.parse(candidate);

  if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
    address = address.toIPv4Address();
  }

  if (address.range() !== 'unicast') {
    return null;
  }

  return address.toString();
}
