import { Model } from 'objection';
import knexFactory, { Knex as KnexType } from 'knex';

import { env } from './env';

const environment = env.NODE_ENV;
let config: KnexType.Config | undefined;

try {
  const rawKnexConfig = require('../../knexfile') as {
    default?: Record<string, KnexType.Config>;
  };
  const knexConfig = (rawKnexConfig.default ?? rawKnexConfig) as Record<string, KnexType.Config>;
  config = knexConfig[environment];
} catch {
  // Fallback for compiled runtime when knexfile.ts isn't loadable.
  config = {
    client: 'pg',
    connection: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      ssl: env.DB_HOST.includes('amazonaws.com') ? { rejectUnauthorized: false } : false,
    },
  };
}

if (!config) {
  throw new Error(`Missing Knex configuration for environment: ${environment}`);
}

export const knex = knexFactory(config);

Model.knex(knex);
