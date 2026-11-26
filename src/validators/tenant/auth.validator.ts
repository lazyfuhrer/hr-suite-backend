import { z } from 'zod';

export const switchOrgSchema = z.object({
  org_id: z.string().uuid(),
  refresh_token: z.string().trim().min(1).optional(),
});

export const verifyForgetPasswordOtpSchema = z.object({
  email: z.string().trim().min(1).email(),
  otp: z.string().trim().min(4).max(6),
});

export const resetForgetPasswordSchema = z.object({
  reset_token: z.string().trim().min(1),
  newPassword: z.string().min(8).max(128),
});
