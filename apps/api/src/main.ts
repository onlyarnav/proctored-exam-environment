import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Enable CORS for frontend integration
  app.enableCors({
    origin: '*', // Adjust origin rules in production
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Set global version prefix as /v1/...
  app.setGlobalPrefix('v1');

  // Input Validation with strict rules (class-validator)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT || 3000;
  await app.listen(port);
  
  logger.log(`Core API Service started on port ${port}`);
}

bootstrap().catch((error) => {
  const logger = new Logger('BootstrapError');
  logger.error('Failed to start Core API Service', error.stack);
  process.exit(1);
});
