import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const appEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  LOG_REQUEST_BODY: z.coerce.boolean().default(false),
  CORS_ORIGIN: z.string().default('*'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('30d'),
  REFRESH_TOKEN_EXPIRES_IN_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30), // 30 days
});

const dbEnvSchema = z.object({
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('hr_management_dev'),
  SSL: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
});

const s3EnvSchema = z.object({
  AWS_REGION: z.string().min(1).optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_PUBLIC_URL: z.string().url().optional(),
  S3_UPLOAD_MAX_MB: z.coerce.number().int().positive().default(20),
});

const kycEnvSchema = z.object({
  KYC_API_URL: z.string().url().optional(),
  KYC_API_KEY: z.string().min(1).optional(),
});

const notificationsEnvSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
  INTERNAL_NOTIFICATIONS_KEY: z.string().min(1).optional(),
});

const envSchema = appEnvSchema
  .extend(dbEnvSchema.shape)
  .extend(s3EnvSchema.shape)
  .extend(kycEnvSchema.shape)
  .extend(notificationsEnvSchema.shape);

export const env = envSchema.parse(process.env);
