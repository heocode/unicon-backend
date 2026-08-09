// NestJS
import { Module } from '@nestjs/common';

// Internal modules
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';

// Internal services
import { NotificationService } from './services/notification.service';

@Module({
  imports: [PrismaModule, MailModule],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
