import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { configureApp } from './configure-app';

async function start() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  configureApp(app);

  const config = new DocumentBuilder()
    .setTitle('Unicon')
    .setDescription('RestAPI documentation / Created By Vadim Iskakov')
    .setVersion('1.0.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('/api/docs', app, document);

  await app.listen(port, () => console.log(`Server started on port = ${port}`));
}
void start();
