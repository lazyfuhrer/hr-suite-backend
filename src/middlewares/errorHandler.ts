import type { ErrorRequestHandler } from 'express';

import { env } from '../config/env';
import { logger } from '../config/logger';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // If the response has already started, delegate to the default Express error handler.
  if (res.headersSent) {
    return;
  }

  // Multer errors should be 4xx (client-side request problem), not 500.
  const isMulterError = (err as any)?.name === 'MulterError';
  const multerCode = typeof (err as any)?.code === 'string' ? (err as any).code : undefined;

  const statusCode =
    typeof (err as any)?.statusCode === 'number' && (err as any).statusCode >= 400
      ? (err as any).statusCode
      : isMulterError
        ? multerCode === 'LIMIT_FILE_SIZE'
          ? 413
          : 400
        : 500;

  const isServerError = statusCode >= 500;

  // Log full error details for observability
  logger.error(
    {
      err,
      method: req.method,
      path: req.originalUrl ?? req.url,
      statusCode,
    },
    'Unhandled error caught by errorHandler middleware',
  );

  const isProd = env.NODE_ENV === 'production';

  const message =
    isServerError && isProd
      ? 'Internal server error'
      : ((err as any)?.message ?? 'Internal server error');

  const responseBody: Record<string, unknown> = {
    message,
  };

  // Optionally surface structured details if the error has them (for known, non-500 errors)
  if (!isServerError) {
    if ((err as any)?.code && typeof (err as any).code === 'string') {
      responseBody.code = (err as any).code;
    }
    if ((err as any)?.details && typeof (err as any).details === 'object') {
      responseBody.details = (err as any).details;
    }
  }

  res.status(statusCode).json(responseBody);
};
