import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { env } from './config/env';
import { loggerOptions } from './config/logger';
import { apiRoutes } from './routes';
import { errorHandler } from './middlewares';

export const app = express();

app.use(express.json());
app.use(helmet());
app.use(
  cors({
    origin: '*',
  }),
);
app.use(
  pinoHttp({
    ...loggerOptions,
    serializers: {
      req: () => undefined,
      res: () => undefined,
    },
    customProps: (req) => {
      if (!env.LOG_REQUEST_BODY) {
        return {};
      }
      const body = (req as Request).body;
      if (body === undefined || body === null) {
        return {};
      }
      return { body };
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) {
        return 'error';
      }
      if (res.statusCode >= 400) {
        return 'warn';
      }
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req, res, err) => {
      if (err) {
        return `${req.method} ${req.url} ${res.statusCode} ${err.message}`;
      }
      return 'silent';
    },
  }),
);
app.use('/api', apiRoutes);

app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ message: 'Server is running' });
});

// Centralized error handling middleware (must be registered after all routes and middleware)
app.use(errorHandler);
