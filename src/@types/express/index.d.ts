import type { SuperAdmin } from '../models/SuperAdmin';
import type { User } from '../models/User';

declare global {
  namespace Express {
    interface Request {
      admin?: SuperAdmin;
      user?: User;
      orgId?: string;
    }
  }
}

export {};
