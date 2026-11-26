import crypto from 'crypto';

export const generateTempPassword = (length = 12): string => {
  const bytes = crypto.randomBytes(Math.ceil(length * 0.75));
  return bytes.toString('base64url').slice(0, length);
};
