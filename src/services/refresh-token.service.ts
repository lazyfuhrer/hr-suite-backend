import { createHash, randomBytes } from 'crypto';

import { env } from '../config/env';

/**
 * Generate an opaque refresh token string.
 *
 * The raw token must be treated as a secret and only the hash is stored server-side.
 */
export const generateRefreshToken = (): string => randomBytes(48).toString('hex');

export const hashRefreshToken = (rawToken: string): string => {
  return createHash('sha256').update(rawToken).digest('hex');
};

export const getRefreshTokenExpiresAtIso = (): string => {
  const expiresAtMs = Date.now() + env.REFRESH_TOKEN_EXPIRES_IN_SECONDS * 1000;
  return new Date(expiresAtMs).toISOString();
};
