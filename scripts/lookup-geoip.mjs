import { config } from 'dotenv';
import ipaddr from 'ipaddr.js';
import { resolve } from 'node:path';
import { Reader } from '@maxmind/geoip2-node';

config({ quiet: true });

const input = process.argv[2]?.trim();

if (!input || !ipaddr.isValid(input)) {
  console.error('Usage: npm run geoip:lookup -- <public-ip>');
  process.exitCode = 1;
} else {
  let address = ipaddr.parse(input);

  if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
    address = address.toIPv4Address();
  }

  if (address.range() !== 'unicast') {
    console.error('GeoIP lookup requires a public IP address.');
    process.exitCode = 1;
  } else {
    const databasePath = resolve(
      process.env.GEOIP_DATABASE_PATH ?? 'data/geoip/GeoLite2-City.mmdb',
    );
    const reader = await Reader.open(databasePath);

    try {
      const result = reader.city(address.toString());

      console.log(
        JSON.stringify(
          {
            countryCode: result.country?.isoCode ?? null,
            city: result.city?.names.en ?? null,
          },
          null,
          2,
        ),
      );
    } catch {
      console.log(JSON.stringify({ countryCode: null, city: null }, null, 2));
    }
  }
}
