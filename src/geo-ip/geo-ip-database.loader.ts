import { Injectable } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import type { ReaderModel } from '@maxmind/geoip2-node';

@Injectable()
export class GeoIpDatabaseLoader {
  async getFingerprint(databasePath: string): Promise<string | null> {
    try {
      const metadata = await stat(databasePath);

      return `${metadata.mtimeMs}:${metadata.size}`;
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  }

  async load(databasePath: string): Promise<ReaderModel> {
    const database = await readFile(databasePath);
    const { Reader } = await import('@maxmind/geoip2-node');

    return Reader.openBuffer(database);
  }
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
