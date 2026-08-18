import { DocumentBuilder } from '@nestjs/swagger';

const bearerOptions = {
  type: 'http' as const,
  scheme: 'bearer',
  bearerFormat: 'JWT',
};

export function createSwaggerConfig() {
  return new DocumentBuilder()
    .setTitle('Unicon')
    .setDescription('Unicon public API documentation.')
    .setVersion('1.0.0')
    .addBearerAuth(bearerOptions, 'access-token')
    .addBearerAuth(bearerOptions, 'refresh-token')
    .build();
}
