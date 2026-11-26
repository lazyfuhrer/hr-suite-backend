import pino from 'pino';

import { env } from './env';

const isProd = env.NODE_ENV === 'production';

export const loggerOptions = {
  level: env.LOG_LEVEL,
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
        },
      },
};

export const logger = pino(loggerOptions);
