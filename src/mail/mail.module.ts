// NestJS
import { Module } from '@nestjs/common';

// Internal services
import { MailService } from './mail.service';

@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
