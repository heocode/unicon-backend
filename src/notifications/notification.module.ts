// NestJS
import { Module } from '@nestjs/common';

// Internal modules
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';

// Internal services
import { NotificationService } from './services/notification.service';
import { AccountDeletionNotificationService } from './services/account-deletion-notification.service';
import { NotificationDeliveryService } from './services/notification-delivery.service';

@Module({
  imports: [PrismaModule, MailModule],
  providers: [
    NotificationService,
    AccountDeletionNotificationService,
    NotificationDeliveryService,
  ],
  exports: [
    NotificationService,
    AccountDeletionNotificationService,
    NotificationDeliveryService,
  ],
})
export class NotificationModule {}
