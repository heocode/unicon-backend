import { INestApplication, ValidationPipe } from '@nestjs/common';

import { PublicHttpExceptionFilter } from './common/filters/public-http-exception.filter';
import { createValidationException } from './common/utils/create-validation-exception.util';

export function configureApp(app: INestApplication): void {
  app.useGlobalFilters(new PublicHttpExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: createValidationException,
    }),
  );
}
