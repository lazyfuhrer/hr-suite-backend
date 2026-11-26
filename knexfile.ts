import type { Knex } from 'knex';

import { env } from './src/config/env';

const baseConfig: Knex.Config = {
  client: 'pg',
  connection: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    ssl: env.SSL ? { rejectUnauthorized: false } : false,
  },
  migrations: {
    directory: './src/database/migrations',
  },
  seeds: {
    directory: './src/database/seeds',
  },
};

const config: Record<string, Knex.Config> = {
  development: baseConfig,
  test: baseConfig,
  production: baseConfig,
};

export default config;
