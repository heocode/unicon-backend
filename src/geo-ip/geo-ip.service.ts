import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import type { ReaderModel } from '@maxmind/geoip2-node';
import { GeoIpDatabaseLoader } from './geo-ip-database.loader';
import type { GeoLocation } from './types/geo-location.type';
import { normalizePublicIp } from './utils/normalize-public-ip.util';

type DatabaseState = 'available' | 'unavailable';

@Injectable()
export class GeoIpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GeoIpService.name);
  private readonly enabled: boolean;
  private readonly databasePath: string;
  private readonly reloadIntervalMilliseconds: number;
  private reader: ReaderModel | null = null;
  private loadedFingerprint: string | null = null;
  private failedFingerprint: string | null = null;
  private databaseState: DatabaseState | null = null;
  private reloadInProgress = false;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(
    configService: ConfigService,
    private readonly databaseLoader: GeoIpDatabaseLoader,
  ) {
    this.enabled = configService.getOrThrow<boolean>('GEOIP_ENABLED');
    this.databasePath = resolve(
      configService.getOrThrow<string>('GEOIP_DATABASE_PATH'),
    );
    this.reloadIntervalMilliseconds =
      configService.getOrThrow<number>('GEOIP_RELOAD_INTERVAL_SECONDS') * 1000;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await this.reloadIfChanged();

    this.reloadTimer = setInterval(() => {
      void this.reloadIfChanged();
    }, this.reloadIntervalMilliseconds);
    this.reloadTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  lookup(ipAddress: string | undefined): GeoLocation | null {
    const reader = this.reader;
    const normalizedIp = normalizePublicIp(ipAddress);

    if (!reader || !normalizedIp) {
      return null;
    }

    try {
      const result = reader.city(normalizedIp);
      const countryCode = result.country?.isoCode;

      if (!countryCode) {
        return null;
      }

      return {
        countryCode,
        city: result.city?.names.en ?? null,
      };
    } catch {
      return null;
    }
  }

  private async reloadIfChanged(): Promise<void> {
    if (this.reloadInProgress) {
      return;
    }

    this.reloadInProgress = true;

    try {
      const fingerprint = await this.databaseLoader.getFingerprint(
        this.databasePath,
      );

      if (!fingerprint) {
        this.reportUnavailable();
        return;
      }

      if (fingerprint === this.loadedFingerprint) {
        this.databaseState = 'available';
        return;
      }

      try {
        const candidateReader = await this.databaseLoader.load(
          this.databasePath,
        );
        const wasLoaded = this.reader !== null;

        this.reader = candidateReader;
        this.loadedFingerprint = fingerprint;
        this.failedFingerprint = null;
        this.databaseState = 'available';

        this.logger.log(
          wasLoaded
            ? 'GeoIP database reloaded successfully.'
            : 'GeoIP database loaded successfully.',
        );
      } catch {
        if (this.failedFingerprint !== fingerprint) {
          this.logger.warn(
            'GeoIP database reload failed. The previous reader remains active.',
          );
          this.failedFingerprint = fingerprint;
        }
      }
    } catch {
      this.reportUnavailable();
    } finally {
      this.reloadInProgress = false;
    }
  }

  private reportUnavailable(): void {
    if (this.databaseState !== 'unavailable') {
      this.logger.warn(
        this.reader
          ? `GeoIP database is unavailable at ${this.databasePath}. The previous reader remains active.`
          : `GeoIP database is unavailable at ${this.databasePath}. Location lookup is disabled.`,
      );
      this.databaseState = 'unavailable';
    }
  }
}
