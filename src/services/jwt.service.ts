import jwt, { type SignOptions } from 'jsonwebtoken';

import { env } from '../config/env';
import type { TokenPayload } from '../types/auth.types';

export const generateToken = (payload: TokenPayload): string => {
  const secret: jwt.Secret = env.JWT_SECRET;
  const expiresIn = env.JWT_EXPIRES_IN as SignOptions['expiresIn'];

  return jwt.sign(payload, secret, { expiresIn });
};

export const verifyToken = (token: string): TokenPayload => {
  return jwt.verify(token, env.JWT_SECRET) as TokenPayload;
};

export const generatePasswordResetToken = (payload: {
  id: string;
  email: string;
  reset_token_id: string;
}): string => {
  const secret: jwt.Secret = env.JWT_SECRET;
  return jwt.sign(
    {
      ...payload,
      role: 'pending',
      type: 'password_reset',
    },
    secret,
    { expiresIn: '15m' },
  );
};
