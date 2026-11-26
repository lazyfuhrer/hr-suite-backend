# HR Management - Local Setup

## Prerequisites
- Node.js >= 18
- npm
- PostgreSQL

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```

2. Create environment file:
   ```bash
   cp .env.example .env
   ```
   Update `.env` with your local values if needed.

3. Create the database (uses `DB_NAME` from `.env`):
   ```bash
   createdb hr_management_dev
   ```
   Or via psql:
   ```sql
   CREATE DATABASE hr_management_dev;
   ```

## Run (Development)
```bash
npm run dev
```

## Database
Run migrations and seeds:
```bash
npm run db:setup
```

## Project Structure
```
.
├── README.md
├── DB_SCHEMA.md
├── TESTING_GUIDE_API.md
├── knexfile.ts
├── package.json
├── src
│   ├── app.ts
│   ├── index.ts
│   ├── @types
│   │   └── express
│   │       └── index.d.ts
│   ├── config
│   │   ├── database.ts
│   │   ├── env.ts
│   │   └── logger.ts
│   ├── controllers
│   │   ├── admin
│   │   │   ├── auth.controller.ts
│   │   │   ├── organization.controller.ts
│   │   │   └── index.ts
│   │   └── tenant
│   │       ├── auth.controller.ts
│   │       ├── department.controller.ts
│   │       ├── user.controller.ts
│   │       └── index.ts
│   ├── database
│   │   ├── migrations
│   │   │   ├── 01_core_schema.ts
│   │   │   ├── 02_hr_modules.ts
│   │   │   ├── 03_add_must_change_password.ts
│   │   │   └── 04_lowercase_user_roles.ts
│   │   └── seeds
│   │       └── 01_seed_super_admin.ts
│   ├── middlewares
│   │   ├── authenticateSuperAdmin.ts
│   │   ├── authenticateTenant.ts
│   │   ├── authorizeRole.ts
│   │   └── index.ts
│   ├── models
│   │   ├── AttendanceBreak.ts
│   │   ├── AttendanceLog.ts
│   │   ├── BaseModel.ts
│   │   ├── Department.ts
│   │   ├── LeaveRequest.ts
│   │   ├── LeaveType.ts
│   │   ├── Organization.ts
│   │   ├── SuperAdmin.ts
│   │   ├── Ticket.ts
│   │   └── User.ts
│   ├── routes
│   │   ├── admin
│   │   │   ├── auth.routes.ts
│   │   │   └── organization.routes.ts
│   │   ├── tenant
│   │   │   ├── auth.routes.ts
│   │   │   ├── department.routes.ts
│   │   │   └── user.routes.ts
│   │   └── index.ts
│   ├── services
│   │   └── jwt.service.ts
│   ├── types
│   │   └── auth.types.ts
│   ├── utils
│   │   └── password.util.ts
│   └── validators
│       ├── admin
│       │   └── index.ts
│       ├── tenant
│       │   ├── index.ts
│       │   └── user.validator.ts
│       └── index.ts
└── tsconfig.build.json
```

## Build & Run (Production)
```bash
npm run build
npm start
```

## Linting & Formatting
```bash
npm run lint
npm run format
npm run format:write
```

## Notes
- Environment validation is centralized in `src/config/env.ts` using Zod.
- Postgres config is in `src/config/database.ts`.
- Husky runs `lint-staged` on pre-commit.
