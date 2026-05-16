import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';

// CSV import file-size cap. Set to 5 MB to match the practical pg-boss
// inline-payload ceiling — CSVs travel base64-encoded inside the job JSON,
// and JSONB rows much above 5 MB make pg-boss queries chunky. The cap goes
// back up to ~50 MB in T8-CSV.2c.3 when we route large files through object
// storage (MinIO/S3) and reference them by key instead of inlining bytes.
const CSV_UPLOAD_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: process.env.NODE_ENV !== 'production' }),
  );

  await app.register(multipart, {
    limits: {
      fileSize: CSV_UPLOAD_MAX_BYTES,
      files: 1,
      fields: 4, // metadata + a few buffer fields
    },
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
  });

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
