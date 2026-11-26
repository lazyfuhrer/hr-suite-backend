# HR Management - API Testing Guide (Ordered)

This guide seeds all data via APIs and follows the required order, including the onboarding flows added in Phase 25.

## Prerequisites
- `.env` has valid DB credentials and `JWT_SECRET`.
- `.env` has S3 settings (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`).
- Migrations are applied:
  ```
  npx knex migrate:latest
  ```
- Database has only the super admin seed data.

## Start the server
```
npm run dev
```

## Push Notifications (FCM) - Setup + Smoke Tests
- Set `INTERNAL_NOTIFICATIONS_KEY` in `.env`.
- Provide Firebase Admin credentials via `FIREBASE_SERVICE_ACCOUNT_JSON` (service account JSON stored as a single env var).

### Register device token (Tenant JWT)
```
curl -X POST http://localhost:3000/api/notifications/devices/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"token":"<FCM_DEVICE_TOKEN>","platform":"gcm","deviceId":"<optional_device_id>"}'
```
Expected: HTTP 200, `{"message":"Device token registered"}`

### Trigger notification event (Internal key)
```
curl -X POST http://localhost:3000/api/notifications/trigger \
  -H "Content-Type: application/json" \
  -H "X-Internal-Key: <INTERNAL_NOTIFICATIONS_KEY>" \
  -d '{
    "event": "test.ping",
    "scope": "tokens",
    "tokens": ["<FCM_DEVICE_TOKEN>"],
    "title": "Hello",
    "body": "This is a test",
    "data": { "foo": "bar" },
    "link": "myapp://notifications"
  }'
```
Expected: HTTP 200 with `{ successCount, failureCount, invalidTokens }`

### Trigger notification event (Client / Bearer token)
Allowed scopes and roles:
- employees: `scope=user` only
- admin/hr/manager: `scope=user` and `scope=org`
Notes:
- client calls cannot use `scope=tokens`
- for `scope=org`, `orgId` is derived from the Bearer token (request org_id is ignored)

```
curl -X POST http://localhost:3000/api/notifications/trigger \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "event": "test.ping",
    "scope": "user",
    "userIds": ["<user_id_in_same_org>"],
    "title": "Hello",
    "body": "This is a test",
    "data": { "foo": "bar" },
    "link": "myapp://notifications"
  }'
```
Expected: HTTP 200 with `{ successCount, failureCount, invalidTokens }` (counts depend on registered devices)

### Periodic location request notifications (Admin/HR/Manager)
Location request notifications are **enabled by default** (`enabled_location_request_notifications: true`, `location_request_interval_hours: 4`). Use `GET /api/notifications/settings` to confirm org settings.

To customize the interval:
```
curl -X PUT http://localhost:3000/api/notifications/settings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "location_request_interval_hours": 2
  }'
```
Expected: HTTP 200 with updated settings.

To disable:
```
curl -X PUT http://localhost:3000/api/notifications/settings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"enabled_location_request_notifications": false}'
```

Notes:
- When enabled, the scheduler sends FCM pushes at shift start and every N hours until shift end (`event=automation.location_request`, `data.action=submit_location`).
- Location prompts are sent only while the employee is **clocked in and not clocked out** for today; the shift-start slot does not fire until after clock-in.
- Location prompts are sent only to employees with `work_mode` **HYBRID** or **REMOTE** (from `employee_employment_details`). ONSITE employees and those with no `work_mode` set do not receive them.
- `location_request_interval_hours` must be between 1 and 24.

### Submit location snapshot (Employee)
```
curl -X POST http://localhost:3000/api/notifications/location-snapshots \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "latitude": 12.9716,
    "longitude": 77.5946,
    "prompt_slot_key": "09:00"
  }'
```
Expected: HTTP 201 with saved snapshot (`latitude`, `longitude`, `captured_at`, `prompt_slot_key`).

### List location snapshots (Admin/HR/Manager)
```
curl -X GET "http://localhost:3000/api/notifications/location-snapshots?userId=<user_id>&from=2026-06-01T00:00:00.000Z&to=2026-06-30T23:59:59.999Z&page=1&limit=25" \
  -H "Authorization: Bearer <TOKEN_B>"
```
Expected: HTTP 200 with paginated `data` array and `pagination` object.

## Step 1: Super Admin Login (Token A)
```
curl -X POST http://localhost:3000/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@shloka.com","password":"Admin@123"}'
```
Expected: HTTP 200, JSON with `token`.
Also returns an opaque `refresh_token` (used for rotating renewals).

## Step 2: Create Organization + First Admin (Temp Password)
```
curl -X POST http://localhost:3000/api/admin/organizations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_A>" \
  -d '{"name":"Acme Corp","company_code":"ACME_TEST","contact_email":"hr@acme.com","admin_name":"John Doe","admin_email":"john@acme.com"}'
```
Expected: HTTP 201, JSON with `organization`, `admin_user`, and `temp_password`.

## Step 3: Tenant Login (Temp Password)
```
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"john@acme.com","password":"<temp_password_from_step_2>"}'
```
Expected: HTTP 200 with `selection_token` and `organizations[]` (array returned even if only one org).
Note: Sending `org_id` in the login payload returns HTTP 400 (`org_id is not allowed in login`).

## Step 4: Tenant Select Org
```
curl -X POST http://localhost:3000/api/auth/select-org \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <selection_token_from_step_3>" \
  -d '{"org_id":"<org_id_from_step_2_or_response>"}'
```
Expected: HTTP 200, `user.must_change_password: true` and a `refresh_token`.
Note: Missing/invalid selection token returns 401/403.

## Step 5: Reset Password (Required)
```
curl -X POST http://localhost:3000/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"currentPassword":"<temp_password_from_step_2>","newPassword":"Welcome@123"}'
```
Expected: HTTP 200, `{"message":"Password updated"}`.

## Step 6: Tenant Login (After Reset)
```
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"john@acme.com","password":"Welcome@123"}'
```
Expected: HTTP 200 with `selection_token` and `organizations[]`.

## Step 7: Tenant Select Org (After Reset)
```
curl -X POST http://localhost:3000/api/auth/select-org \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <selection_token_from_step_6>" \
  -d '{"org_id":"<org_id_from_step_2_or_response>"}'
```
Expected: HTTP 200, `user.must_change_password: false` and a `refresh_token` (store as `<refreshTokenB_from_step_7>`).

### Refresh Access Token (Rotating)
```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"<refreshTokenB_from_step_7>"}'
```
Expected: HTTP 200 with a new `token` and a new `refresh_token`. Re-using the old `refresh_token` should fail (401 Unauthorized).

## Multi-org switch (Admin/HR)

Use this when the same person is **admin** or **hr** in more than one organization (same `official_email`, same password on each org user row).

### Cross-org password reuse (admin/HR)

When you create another **admin** or **hr** with an email that already exists as admin/hr in another org:

- The new account **reuses** that password (`password_hash` + `must_change_password`).
- **No** welcome email with a new temp password is sent.
- Create responses include `password_reused: true` and omit `temp_password`.
- **Eligibility gate:** target role `admin` may clone when source `onboarding_status` is pending/in-progress/completed; target role `hr` requires source `onboarding_status` = `COMPLETED`.
- **Full clone** from the source account (`onboarding_data_cloned: true` when any data was copied): profile, addresses, emergency contacts, identities, bank details, **all** user documents (including offer/joining/contract/appointment letters), full payroll (PAN/Aadhaar/PF/UAN/ESI/tax), employment/CTC details, benefits, salary structures (component ids remapped by **code** in the target org), assets/device/policy/signed flags, `onboarding_status`, `completed_at`, all `kyc_*`, plus `designation` / `date_of_joining` / name fields.
- **Not copied:** `department_id`, `manager_id`, `shift_id`, `employee_id`.
- S3 files are copied under the new org/user path; face is re-indexed for the new user. Bank/doc verification resets to `PENDING` on initial clone (continuous sync may push stored verification values).
- Later updates to any of the cloned domains for an admin/hr **continuously sync** to all other admin/hr rows with the same email (still never syncing department/manager/shift/employee_id).

#### Explicit API: clone/sync by email into the current org

Tenant admin/hr authenticated against the **target** org:

```
curl -X POST http://localhost:3000/api/users/cross-org-sync \
  -H "Authorization: Bearer <TOKEN_B>" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","role":"admin"}'
```

Expected: HTTP 201 (created) or 200 (existing admin/hr updated)

```json
{
  "message": "Admin/HR user created and cloned from source organization",
  "cloned": true,
  "created": true,
  "user_id": "...",
  "password_reused": true,
  "source_org_id": "...",
  "onboarding_status": "COMPLETED",
  "role": "admin"
}
```

- Missing source admin/hr → HTTP 404
- HR role but source onboarding not `COMPLETED` → HTTP 400
- Email already exists in current org as non-admin/hr → HTTP 409

Password changes for admin/hr (`reset-password`, forgot-password reset, `send-temporary-password`) **sync** the new hash to **all** other admin/hr rows with the same email.

Managers and employees are unchanged (each org still gets its own password; no onboarding clone).

### Prerequisites

1. Create a second organization (super admin) with the **same** `admin_email` as the first org’s admin, or add an admin/HR user in Org B with the same work email as Org A.
2. Complete login + `select-org` for Org A and store `<TOKEN_B>` and `<refreshTokenB>`.

### List switchable organizations

```
curl -X GET http://localhost:3000/api/auth/switchable-orgs \
  -H "Authorization: Bearer <TOKEN_B>"
```

Expected: HTTP 200

```json
{
  "current_org_id": "<org_a_id>",
  "organizations": [
    {
      "org_id": "...",
      "name": "...",
      "company_code": "...",
      "logo_url": null,
      "role": "admin",
      "is_current": true
    }
  ]
}
```

- Only orgs where the user is **admin** or **hr**, org is active/not expired, and `must_change_password` is false.
- Managers and employees cannot call this endpoint (403).

### Switch organization (no re-login)

```
curl -X POST http://localhost:3000/api/auth/switch-org \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"org_id":"<org_b_id>","refresh_token":"<refreshTokenB>"}'
```

Expected: HTTP 200 with new `token`, `refresh_token`, and `user` (same shape as `select-org`). Replace stored tenant token and refresh token in the client.

Errors:

- `400` `Already in this organization` when `org_id` is the current org.
- `403` `Org switch not allowed` when no admin/HR user exists for that email in the target org.
- `403` `Password reset required` when the target org user still has `must_change_password: true`.

After switch, org-scoped APIs (e.g. `GET /api/users`) reflect the **target** organization.

## Step 8: Create Department (Token B)
```
curl -X POST http://localhost:3000/api/departments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "name":"Engineering",
    "manager_ids":["<optional_manager_user_id_1>","<optional_manager_user_id_2>"],
    "employee_ids":[
      "<optional_employee_user_id_1>",
      "<optional_employee_user_id_2>"
    ],
    "location": {
      "name": "Headquarters",
      "latitude": 22.5726,
      "longitude": 88.3639,
      "radius_meters": 100
    },
    "default_shift": {
      "name": "General Shift",
      "start_time": "09:00:00",
      "end_time": "18:00:00",
      "break_duration_mins": 60
    },
    "working_days": [
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY"
    ]
  }'
```
Expected: HTTP 201, JSON with department `id` and full details including `location`, `defaultShift`, `managers` (array), `manager_ids` (array of manager user IDs), and `users` (all assigned employees, including managers if their `department_id` is set).

**Field Details:**
- `name`: Required string (unique within org).
- `manager_ids`: Optional array of manager user UUIDs. When provided:
  - Every ID must belong to the same organization
  - Every user must be non-deleted with `status: "ACTIVE"`
  - Each listed manager’s `department_id` is automatically set to this new department.
- `employee_ids`: Optional array of UUIDs. When provided:
  - All users must exist in the same organization and not be soft-deleted
  - Each listed user’s `department_id` is set to this new department.
- `location` (optional): Inline office location payload to be created and linked to the department:
  - `name`: Required string
  - `latitude`: Required number
  - `longitude`: Required number
  - `radius_meters`: Optional positive integer (default 100) – geofence radius in meters.
- `default_shift` (optional): Inline work shift payload to be created and linked as the department’s default shift:
  - `name`: Required string
  - `start_time`: Required string in `HH:MM:SS` format
  - `end_time`: Required string in `HH:MM:SS` format
  - `break_duration_mins`: Optional non-negative integer (default 60).
- `working_days` (optional): Array of weekday strings indicating working days for the department.
  - Allowed values (case-insensitive, stored as uppercase): `MONDAY`, `TUESDAY`, `WEDNESDAY`, `THURSDAY`, `FRIDAY`, `SATURDAY`, `SUNDAY`.
  - Example: `["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"]` (Saturday/Sunday off).

If any `manager_ids` or `employee_ids` are invalid, the request fails with HTTP 400 and **no partial updates** (department is not created).

**Aadhaar OTP generate (`POST /api/onboarding/aadhaar/otp`):** HTTP **200** when OTP generation succeeds; HTTP **422** when the provider rejects the Aadhaar number (e.g. invalid card) even if a `reference_id` is present; “insufficient privilege” / credential issues return **503**; upstream failures return **502**.

**Aadhaar OTP verify (`POST /api/onboarding/aadhaar/verify-otp`):** HTTP **200** when `status` is `VALID`; HTTP **422** when verification fails (`status` is not `VALID`). Provider-side errors such as “request under process” or quota issues may return **503**; invalid `referenceId` returns **400**; upstream failures return **502**.

**PAN verify (`POST /api/onboarding/pan/verify`):** HTTP **200** only when `status` is `valid` and both `name_match` and `dob_match` are true; otherwise **422** for the same verification payload. Insufficient credits or privilege returns **503**; upstream failures return **502**.

**Bank verify (`POST /api/onboarding/bank/verify`):** HTTP **200** when `status` is `VERIFIED`; **422** when verification fails (`FAILED`); **400** when bank details are incomplete (`PENDING` with “Waiting for bank account details”); **503** for temporary provider unavailability or other `PENDING` outcomes; catch-path quota/unavailable errors return **503** (not 200); other upstream errors return **502**.

## Step 9: Create Employee via Onboarding (Token B) — Preferred
Creates User + Profile (+ optional EmergencyContacts + Addresses) in a single transaction. Profile object is required, but all inner fields (including `dob` and `gender`) are now optional.

```
curl -X POST http://localhost:3000/api/onboarding \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "email":"sarah@acme.com",
    "firstName":"Sarah",
    "lastName":"Smith",
    "employeeType":"employee",
    "phone":"+91-9999999999",
    "profile":{
      "marital_status":"SINGLE",
      "nationality":"Indian",
      "personal_email":"sarah.personal@acme.com",
      "personal_phone":"+91-9999999999",
      "alt_phone":"+91-9888888888",
      "emergency_contacts":[
        {
          "name":"John Smith",
          "relation":"FATHER",
          "phone":"+91-9777777777",
          "email":"john.smith@example.com",
          "is_primary":true
        }
      ],
      "addresses":[
        {
          "type":"PRESENT",
          "street_address":"12 Park Street",
          "city":"Kolkata",
          "state":"WB",
          "zip_code":"700001",
          "country":"India"
        }
      ]
    }
  }'
```
Expected: HTTP 201, JSON with user details and `onboarding_status: "IN_PROGRESS"`. No `temp_password` is returned at this stage.

**Field Details:**
- `email`: Required string (valid email format). Must be unique within the organization.
- `firstName`: Required string (minimum 1 character).
- `lastName`: Optional string (empty string is allowed; DB column is non-nullable).
- `phone`: Optional string.
- `employeeType`: Optional string enum (`employee`, `manager`). Defaults to `employee` when omitted.
- `profile`: **Required** object containing:
  - `dob`: Optional string (date of birth, `YYYY-MM-DD` format). Empty string is treated as not provided.
  - `gender`: Optional enum (`MALE`, `FEMALE`, `OTHER`). Empty string is treated as not provided.
  - `marital_status`: Optional enum (`SINGLE`, `MARRIED`, `DIVORCED`).
  - `nationality`: Optional string (can be omitted or empty).
  - `personal_email`: Optional string (valid email format). Must be unique across all users if provided.
  - `personal_phone`: Optional string.
  - `alt_phone`: Optional string.
  - `emergency_contacts`: Optional array (defaults to empty). When provided, each contact requires:
    - `name`: Required string
    - `relation`: Required string
    - `phone`: Required string
    - `email`: Optional string (valid email format)
    - `is_primary`: Optional boolean (default: false)
  - `addresses`: Optional array (defaults to empty). When provided, each address requires:
    - `type`: Required enum (`PRESENT`, `PERMANENT`)
    - `street_address`: Optional string
    - `city`: Optional string
    - `state`: Optional string
    - `zip_code`: Optional string
    - `country`: Optional string

**Important Notes:**
- Store the returned employee `id` as `<employee_user_id>` for the next steps.
- The temporary password will be generated only after onboarding is fully completed (Step 17).
- The `employee_id` (human-friendly employee code) is **not** set at this stage. It is assigned later in Step 13 via the employment API (`PUT /api/onboarding/<employee_user_id>/employment`) using the `employeeId` field.
- The employee's initial `status` is set to `ACTIVE` and `must_change_password` is set to `false` (will be updated when onboarding completes).
- **All profile data is created in a single transaction** - User, UserProfile, EmergencyContacts, and Addresses are created atomically.
- Onboarding status starts as `IN_PROGRESS` since profile is created immediately.

**Edge Cases:**
- Duplicate `email` within the same organization → HTTP 409
- Duplicate `personal_email` across all users → HTTP 409
- Missing required fields (`email`, `firstName`, `profile`) → HTTP 400
- Invalid email format → HTTP 400
- Invalid enum values (`gender`, `marital_status`, `address.type`) → HTTP 400

> Legacy path: `POST /api/users` is still available but should be treated as a legacy/admin-only way of creating users. Prefer the onboarding-centric flow above for employees.
>
> For the legacy `POST /api/users` endpoint:
> - `role` can be `admin`, `hr`, `manager`, or `employee`.
> - `departmentId` is **optional**. When omitted or null, the user is created without any department (`department_id` remains null) and can be assigned later via department APIs.

## Step 10: Employee Onboarding (Admin/HR) - Get Current State (Token B)
```
curl -X GET http://localhost:3000/api/onboarding/<employee_user_id> \
  -H "Authorization: Bearer <TOKEN_B>"
```
Expected: HTTP 200 with current onboarding data and `step_completion` for that employee.
Note: Profile data should already be present from Step 9, so `profile_complete` should be `true`.

## Step 11: Employee Onboarding (Admin/HR) - Update Financials (Token B)
```
curl -X PUT http://localhost:3000/api/onboarding/<employee_user_id>/finance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "payroll_info": {
      "annual_ctc": 1000000
    },
    "earnings": {
      "basic_salary": 50000,
      "hra": 20000,
      "conveyance_allowance": 5000,
      "gross_earnings": 75000
    },
    "deductions": {
      "pf": 1800,
      "professional_tax": 200,
      "income_tax_tds": 5000,
      "esi": 0,
      "total_deductions": 7000
    },
    "net_payable": {
      "salary_per_month": 68000
    }
  }'
```
Expected: HTTP 200, `{"message":"Financial details updated successfully"}`.

**Field Details:**
- `payroll_info.annual_ctc`: Required non-negative number (may be sent as string or number).
- `earnings`: Required object:
  - `basic_salary`, `hra`, `conveyance_allowance`, `gross_earnings`: Required non-negative numbers.
- `deductions`: Required object:
  - `pf`, `professional_tax`, `income_tax_tds`, `esi`, `total_deductions`: Required non-negative numbers.
- `net_payable.salary_per_month`: Required non-negative number.

**Important:**
- The payload is **strict**: unknown keys at any level will return HTTP 400.
- `annual_ctc` and `basic_salary` are stored in `employee_employment_details`; salary breakup is stored in `salary_structures`.

## Step 13: Employee Onboarding (Admin/HR) - Employment Details (Token B)
Capture employee ID, department, job title, joining date, work model, and shift mode. All fields are optional.
```
curl -X PUT http://localhost:3000/api/onboarding/<employee_user_id>/employment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "employeeId":"EMP-0289",
    "department_id":"<dept_id_from_step_8>",
    "designation":"IT Support Specialist",
    "date_of_joining":"2024-06-19",
    "employment_type":"FULL_TIME",
    "work_mode":"ONSITE",
    "shift_mode":"day"
  }'
```
Expected: HTTP 200, `{"message":"Employment details updated successfully"}`.

**Field Details:**
- `employeeId`: Optional string. When provided, sets/updates the human-readable employee code (must be unique within the organization). If the value already exists for another user in the org, the API returns HTTP 409.
- `department_id`: Optional UUID. Must exist in the organization. If invalid, returns 400.
- `designation`: Optional string (job title).
- `date_of_joining`: Optional string in `YYYY-MM-DD` format.
- `employment_type`: Optional enum (`FULL_TIME`, `PART_TIME`, `CONTRACT`, `INTERN`).
- `work_mode`: Optional enum (`ONSITE`, `HYBRID`, `REMOTE`).
- `shift_mode`: Optional enum (`day`, `night`). Currently stored in `employee_employment_details.notes`.

**Edge Cases:**
- Invalid `department_id` (non-existent UUID) → HTTP 400
- Invalid `employment_type` or `work_mode` enum values → HTTP 400
 - Duplicate `employeeId` within the same organization → HTTP 409

## Step 14: Employee Onboarding (Admin/HR) - Document Upload (2-Step Flow - Recommended)

### Option A: Bulk File Upload (Recommended for Multiple Files - 2 API Calls Total)

**Step 14a: Upload Multiple Files Directly to S3**

Upload multiple files in a single API call. All files are uploaded in parallel.

```bash
curl -X POST http://localhost:3000/api/uploads \
  -H "Authorization: Bearer <TOKEN_B>" \
  -F "files=@pan-card.png" \
  -F "files=@aadhaar-card.png" \
  -F "files=@passport.pdf" \
  -F "doc_category=IDENTITY" \
  -F "doc_types=[\"PAN_CARD\", \"AADHAAR_CARD\", \"PASSPORT\"]"
```

**Alternative:** Use single `doc_type` for all files:
```bash
curl -X POST http://localhost:3000/api/uploads \
  -H "Authorization: Bearer <TOKEN_B>" \
  -F "files=@document1.pdf" \
  -F "files=@document2.pdf" \
  -F "doc_category=EDUCATION" \
  -F "doc_type=DEGREE_CERTIFICATE"
```

**Expected Response (HTTP 200):**
```json
{
  "files": [
    {
      "file_url": "https://hr-suite-bucket.s3.ap-south-1.amazonaws.com/orgs/.../pan-card.png",
      "file_key": "orgs/.../pan-card.png",
      "file_name": "pan-card.png",
      "file_size": 245612,
      "content_type": "image/png",
      "doc_category": "IDENTITY",
      "doc_type": "PAN_CARD"
    },
    {
      "file_url": "https://hr-suite-bucket.s3.ap-south-1.amazonaws.com/orgs/.../aadhaar-card.png",
      "file_key": "orgs/.../aadhaar-card.png",
      "file_name": "aadhaar-card.png",
      "file_size": 189234,
      "content_type": "image/png",
      "doc_category": "IDENTITY",
      "doc_type": "AADHAAR_CARD"
    }
  ],
  "count": 2
}
```

**Notes:**
- Upload up to 20 files in a single request
- Files are uploaded to S3 in parallel for better performance
- `doc_types` array must match the number of files (one doc_type per file)
- Or use single `doc_type` to apply the same type to all files
- File size must be within `S3_UPLOAD_MAX_MB` limit (default 20MB) per file
- Valid `doc_category` values: `IDENTITY`, `EDUCATION`, `EXPERIENCE`, `FINANCE`, `LEGAL`

## Step 14: Upload Documents with Files (Recommended - Single API Call)

**NEW: Merged API - Upload files and save metadata in one call!**

The `/api/onboarding/:userId/documents` endpoint now accepts files directly via `multipart/form-data`. Files are automatically uploaded to S3 and document metadata is saved to the database in a single API call.

### Option A: Multiple Files Upload (Recommended)

Upload multiple files at once with their document types.

```bash
curl -X POST http://localhost:3000/api/onboarding/<employee_user_id>/documents \
  -H "Authorization: Bearer <TOKEN_B>" \
  -F "files=@pan-card.png" \
  -F "files=@aadhaar-card.png" \
  -F "files=@passport.pdf" \
  -F "doc_category=IDENTITY" \
  -F "doc_types=[\"PAN_CARD\",\"AADHAAR_CARD\",\"PASSPORT\"]"
```

**Form Fields:**
- `files` (required, multiple): The actual files to upload (can upload up to 20 files)
- `doc_category` (required): One of `IDENTITY`, `EDUCATION`, `EXPERIENCE`, `FINANCE`, `LEGAL`
- `doc_types` (required if `doc_type` not provided): JSON array of document types, one per file (must match number of files)
- `doc_type` (required if `doc_types` not provided): Single document type to apply to all files

**Expected Response (HTTP 201):**
```json
{
  "documents": [
    {
      "id": "...",
      "doc_category": "IDENTITY",
      "doc_type": "PAN_CARD",
      "file_url": "https://hr-suite-bucket.s3.ap-south-1.amazonaws.com/orgs/.../pan-card.png",
      "file_key": "orgs/.../pan-card.png",
      "verification_status": "PENDING"
    },
    {
      "id": "...",
      "doc_category": "IDENTITY",
      "doc_type": "AADHAAR_CARD",
      "file_url": "https://hr-suite-bucket.s3.ap-south-1.amazonaws.com/orgs/.../aadhaar-card.png",
      "file_key": "orgs/.../aadhaar-card.png",
      "verification_status": "PENDING"
    },
    {
      "id": "...",
      "doc_category": "IDENTITY",
      "doc_type": "PASSPORT",
      "file_url": "https://hr-suite-bucket.s3.ap-south-1.amazonaws.com/orgs/.../passport.pdf",
      "file_key": "orgs/.../passport.pdf",
      "verification_status": "PENDING"
    }
  ],
  "count": 3
}
```

### Option B: Single File Upload

Upload one file at a time.

```bash
curl -X POST http://localhost:3000/api/onboarding/<employee_user_id>/documents \
  -H "Authorization: Bearer <TOKEN_B>" \
  -F "files=@pan-card.png" \
  -F "doc_category=IDENTITY" \
  -F "doc_type=PAN_CARD"
```

**Expected Response (HTTP 201):**
```json
{
  "documents": [
    {
      "id": "...",
      "doc_category": "IDENTITY",
      "doc_type": "PAN_CARD",
      "file_url": "https://hr-suite-bucket.s3.ap-south-1.amazonaws.com/orgs/.../pan-card.png",
      "file_key": "orgs/.../pan-card.png",
      "verification_status": "PENDING"
    }
  ],
  "count": 1
}
```

**Benefits of Merged API:**
- ✅ **Single API call** - Upload files and save metadata in one request
- ✅ **Automatic S3 upload** - Files are uploaded to S3 automatically
- ✅ **Parallel processing** - Multiple files uploaded in parallel for better performance
- ✅ **Simplified frontend** - No need to manage separate upload and save steps
- ✅ **Reduced API calls** - From 2-3 calls down to just 1 call

**Notes:**
- Maximum file size: 20MB per file (configurable via `S3_UPLOAD_MAX_MB`)
- Maximum files per request: 20
- Files are automatically stored in S3 with organized paths: `orgs/{org_id}/users/{user_id}/documents/{doc_category}/{doc_type}/{uuid}-{filename}`
- All files must have the same `doc_category` in a single request
- If uploading multiple files, use `doc_types` array (one per file) or `doc_type` (applied to all files)

### Passport photo face validation (`PASSPORT_SIZE_PHOTO`)

When a upload batch includes `passport_size_photo` (field name) / `PASSPORT_SIZE_PHOTO` (stored `doc_type`), the API indexes the image in Rekognition. The following endpoints share the same validation and **reject-all** behavior on failure:

- `POST /api/onboarding/:userId/documents` (admin/HR upload)
- `POST /api/onboarding/employee/documents` (employee self-upload during onboarding)
- `POST /api/onboarding/employee/documents/upload-extra` (employee additional uploads)

On face-index failure the API returns **HTTP 400** (not 201), rolls back `user_documents` rows created in that request, and best-effort deletes uploaded S3 objects.

Example employee self-upload:

```bash
curl -X POST http://localhost:3000/api/onboarding/employee/documents \
  -H "Authorization: Bearer <TOKEN_C>" \
  -F "passport_size_photo=@no-face.jpg"
```

Expected when no face is detected: **HTTP 400**

```json
{
  "message": "No face detected in `passport_size_photo`. Please upload a clear front-facing photo."
}
```

Other face-index errors:

- `InvalidImageFormatException` → 400, JPG/PNG required (PDF not supported)
- Other indexing failures → 400, generic processing message

---

### Option C: Metadata-Only Upload (Backward Compatibility)

If you've already uploaded files to S3 (e.g., using presigned URLs), you can still save just the metadata:

**Single Document:**
```bash
curl -X POST http://localhost:3000/api/onboarding/<employee_user_id>/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "doc_category": "IDENTITY",
    "doc_type": "PAN_CARD",
    "file_url": "https://example.com/pan-card.png",
    "file_key": "orgs/.../pan-card.png"
  }'
```

**Multiple Documents:**
```bash
curl -X POST http://localhost:3000/api/onboarding/<employee_user_id>/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "documents": [
      {
        "doc_category": "IDENTITY",
        "doc_type": "PAN_CARD",
        "file_url": "https://example.com/pan-card.png",
        "file_key": "orgs/.../pan-card.png"
      },
      {
        "doc_category": "IDENTITY",
        "doc_type": "AADHAAR_CARD",
        "file_url": "https://example.com/aadhaar-card.png",
        "file_key": "orgs/.../aadhaar-card.png"
      }
    ]
  }'
```

---

### Option D: Presigned URL Flow (3-Step Flow - For Advanced Use Cases)

**Step 14: Get Presigned URL (Token B)**

Request a presigned URL for direct S3 upload.
```
curl -X POST http://localhost:3000/api/uploads/upload \
  -H "Authorization: Bearer <TOKEN_B>" \
  -F "file=@pan-card.png" \
  -F "doc_category=IDENTITY" \
  -F "doc_type=PAN_CARD"
```

**Step 15: Upload File to S3 (Client-Side)**

Upload the file directly to S3 using the presigned URL from Step 14.
```
curl -X PUT "<upload_url_from_step_14>" \
  -H "Content-Type: image/png" \
  --data-binary @pan-card.png
```

**Step 16: Save Document Metadata (Token B)**
Save the document metadata in the database after successful S3 upload.
```
curl -X PUT http://localhost:3000/api/onboarding/<employee_user_id>/compliance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "asset_agreement": true,
    "policy_acknowledged": true,
    "document_list": [
      {
        "doc_category": "IDENTITY",
        "doc_type": "PAN_CARD",
        "file_url": "<file_url_from_step_14>",
        "file_key": "<file_key_from_step_14>"
      }
    ],
    "send_welcome_email": true
  }'
```

Expected: HTTP 200. Compliance upserts into `user_documents` inside the same transaction.

### Local / Dummy Flow (No S3) for Employee Documents

For **local development**, you may not have S3 configured and the `/api/uploads/presign` endpoint (Step 14) will fail with HTTP 500. To keep employee onboarding fully testable **without S3**, you can:

1. **Skip Step 14 (presign) and Step 15 (actual S3 upload) entirely.**
2. Call Step 16 directly using any valid public URL as a dummy `file_url`, for example:

   ```
   curl -X POST http://localhost:3000/api/onboarding/<employee_user_id>/documents \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <TOKEN_B>" \
     -d '{
       "doc_category":"IDENTITY",
       "doc_type":"PAN_CARD",
       "file_url":"https://example.com/dummy-pan-card.png"
     }'
   ```

Notes:
- `file_url` is only validated as a URL; the server does **not** verify that the file actually exists.
- This dummy approach is sufficient to mark document steps as completed in onboarding and to exercise the full onboarding flow locally.

## Step 17: Employee Onboarding (Admin/HR) - Submit Compliance, Benefits & Finalize (Token B)
```
curl -X PUT http://localhost:3000/api/onboarding/<employee_user_id>/compliance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "device_pref":"WINDOWS",
    "asset_agreement":true,
    "policy_acknowledged":true,
    "documents": {
      "offer_letter_url":"https://example.com/offer-letter.pdf",
      "cv_url":"https://example.com/cv.pdf",
      "id_url":"https://example.com/id.pdf",
      "contract_agreement_url":"https://example.com/contract.pdf"
    },
    "allowances":{
      "transportation":true,
      "meal":true,
      "internet":true
    },
    "benefits":{
      "health_insurance":true,
      "life_insurance":true,
      "company_device":true,
      "training_program":true,
      "tuition":false,
      "fitness_membership":false,
      "mental_health_support":true
    },
    "active_employee":true,
    "send_welcome_email":true
  }'
```
Expected: HTTP 200, `onboarding_status: "COMPLETED"` when offer letter URL is provided.  
If this is the first time onboarding transitions to `COMPLETED` **and** `send_welcome_email` is true, the response also includes `temp_password`, which should be stored as `<employee_temp_password>` for the employee's first login.

**Field Details:**
- `device_pref`: Optional enum (`WINDOWS`, `MACBOOK`, `LINUX`). When omitted, previous value (if any) is preserved.
- `asset_agreement`: Optional boolean.
- `policy_acknowledged`: Optional boolean.
- `offer_letter_url`: Optional string (valid URL). For backward compatibility; if `documents.offer_letter_url` is provided, that is preferred.
- `documents`: Optional object grouping related URLs:
  - `offer_letter_url`: Optional string (valid URL) for the signed offer letter.
  - `cv_url`: Optional string (valid URL) for the CV/resume.
  - `id_url`: Optional string (valid URL) for identity proof.
  - `contract_agreement_url`: Optional string (valid URL) for the employment contract.
- `allowances`: Optional object with boolean fields:
  - `transportation`: Optional boolean
  - `meal`: Optional boolean
  - `internet`: Optional boolean
- `benefits`: Optional object with boolean fields:
  - `health_insurance`: Optional boolean
  - `life_insurance`: Optional boolean
  - `company_device`: Optional boolean
  - `training_program`: Optional boolean
  - `tuition`: Optional boolean
  - `fitness_membership`: Optional boolean
  - `mental_health_support`: Optional boolean
- `active_employee`: Optional boolean. If `true`, sets user `status` to `ACTIVE`; if `false`, sets to `INACTIVE`.
- `send_welcome_email`: Optional boolean. If `true` and onboarding is completing for the first time, generates and returns `temp_password`.

**Important Notes:**
- Onboarding is marked as `COMPLETED` only when `asset_agreement`, `policy_acknowledged`, and `offer_letter_signed` (derived from `documents.offer_letter_url` or `offer_letter_url`) are all `true`.
- The `temp_password` is generated only when:
  1. Onboarding transitions to `COMPLETED` for the first time (was not `COMPLETED` before)
  2. `send_welcome_email` is `true`
- After this step, the employee's `onboarding_status` is `COMPLETED`, and only then will employee login be allowed.
- Benefits and allowances are stored in the `employee_benefits` table with appropriate `benefit_type` values.

**Edge Cases:**
- Invalid `device_pref` enum → HTTP 400
- Invalid URL format for any URL field in `documents` or top-level `offer_letter_url` → HTTP 400

## Step 18: Employee Login (Temp Password)
```
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"sarah@acme.com","password":"<employee_temp_password>"}'
```
Expected: HTTP 200 with `selection_token` and `organizations[]`.
Note: If onboarding is not yet completed, this login will be rejected for employees.

## Step 19: Employee Select Org
```
curl -X POST http://localhost:3000/api/auth/select-org \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <selection_token_from_step_17>" \
  -d '{"org_id":"<org_id_from_step_2_or_response>"}'
```
Expected: HTTP 200, `user.must_change_password: true`. Use the returned token as `<TOKEN_C>` for the next steps.

## Step 20: Employee Reset Password (Required Before Self-Onboarding)
```
curl -X POST http://localhost:3000/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"currentPassword":"<employee_temp_password>","newPassword":"EmpNew@123"}'
```
Expected: HTTP 200, `{"message":"Password updated"}`.

**Important:** Employees must reset their temporary password before they can access self-onboarding endpoints (`PUT /api/onboarding/finance`, etc.). Attempting to access these endpoints without resetting the password will return HTTP 403 with `{"message":"Password reset required"}`.

## Step 21: Employee Login (After Reset)
```
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"sarah@acme.com","password":"EmpNew@123"}'
```
Expected: HTTP 200 with `selection_token` and `organizations[]`.

## Step 22: Employee Select Org (After Reset)
```
curl -X POST http://localhost:3000/api/auth/select-org \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <selection_token_from_step_20>" \
  -d '{"org_id":"<org_id_from_step_2_or_response>"}'
```
Expected: HTTP 200, valid token. Use this final token as `<TOKEN_C>` for attendance and other employee APIs.

## Step 21: Users List + Statistics (Optional)
```
curl -X GET "http://localhost:3000/api/users?page=1&limit=10&role=employee" \
  -H "Authorization: Bearer <TOKEN_B>"
```
Expected: HTTP 200, JSON with:
- `page`, `limit`, `total`, `total_pages`, and `data` array (users list)
- `statistics` object containing the same fields as the old `/api/users/statistics` endpoint.
Optional query parameters:
- `page` (default: 1)
- `limit` (default: 10, max: 100)
- `role` = `admin|hr|manager|employee`
- `status` = `ACTIVE|INACTIVE|ON_NOTICE|ALL` (default: `ACTIVE`)
- `department_id` (UUID)
- `search` (searches employee_id, name, email)

## Step 22: Employee Statistics (Admin/HR)
Get only user statistics for the current month using the unified users endpoint (no list data).
```
curl -X GET "http://localhost:3000/api/users?view=statistics" \
  -H "Authorization: Bearer <TOKEN_B>"
```
Expected: HTTP 200, JSON with:
- `total_users` — active workforce only (`ACTIVE` + `ON_NOTICE`; excludes `INACTIVE`)
- `past_users_count` — count of separated employees (`INACTIVE`)
- `past_users[]` — list of past users (same shape as users list rows, plus optional `exit` object with `id`, `exit_type`, `last_working_day`, `exited_at` when a completed exit exists)
- `new_users_this_month`
- `resigned_users_this_month`
- `turnover_rate`
- “From last month” deltas:
  - `total_users_change_pct_from_last_month`
  - `new_users_change_pct_from_last_month`
  - `resigned_users_change_pct_from_last_month`
  - `turnover_rate_change_pct_from_last_month`
- `period` (month, year, start_date, end_date)
- `compare_period` (previous month period)
Note: Accessible to `admin`, `hr`, and `manager` (managers see scoped team data). Statistics are calculated for the current month automatically. Turnover rate is calculated as (resigned users / total users) × 100. You can optionally filter by role using the `role` query parameter (e.g., `?role=employee`). By default (`GET /api/users` without `view`), both list and statistics are returned together in one API call (`view=both`).

## Step 21a: Unassigned Users (No Department) (Admin/HR)

List users in the current organization who are **not assigned to any department** (`department_id` is `null`). This includes all roles by default.

```
curl -X GET "http://localhost:3000/api/users/unassigned?status=ACTIVE" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Optional query parameters:
- `role` = `admin|hr|manager|employee`
- `status` = `ACTIVE|INACTIVE|ON_NOTICE|ALL` (default: `ACTIVE`)

Expected: HTTP 200, JSON:
- `items[]`: `{ id, employee_id, full_name, first_name, last_name, official_email, role, status }`

Notes:
- Only users with `department_id = null` and not soft-deleted are returned.
- Use this endpoint to quickly find employees/admins/managers/HR who still need to be mapped into departments.

## Step 21a-2: Admin send temporary password email (Admin/HR)

Org **admin** or **HR** can send a new temporary password to a user’s **official email** in the same organization. Device accounts and inactive users are excluded.

```
curl -X POST "http://localhost:3000/api/users/send-temporary-password" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B_ADMIN_OR_HR>" \
  -d '{ "email": "employee@example.com" }'
```

- **404** if no matching active user (non-device) in the org for that email.
- **200** `{ "message": "A temporary password has been sent to the user's official email address." }` — the temporary password is not returned in the API response; Msg91 sends it by email asynchronously (email failures are logged, not returned as HTTP errors).

**Employee steps after receipt:** sign in with the temporary password and complete org selection, then call `POST /api/auth/reset-password` with `currentPassword` (temporary) and `newPassword` (see Step 5 / employee reset password in this guide).

**Msg91:** create template id `reset_password_email_template` with variables `ORG_NAME`, `EMPLOYEE_NAME`, `LOGIN_EMAIL`, `TEMP_PASSWORD`, `IOS_APP_URL`, `ANDROID_APP_URL`.

## Forgot password (OTP via Msg91, unauthenticated)

Users who forgot their password can request a 4-digit OTP by **official email**. OTP expires in **10 minutes**. No auth header required.

**Send OTP**

```
curl -X POST "http://localhost:3000/api/auth/forget-password" \
  -H "Content-Type: application/json" \
  -d '{ "email": "employee@example.com" }'
```

- **404** if no user exists with that `official_email`.
- **503** if Msg91 email send fails (no new OTP row is stored).
- **200** `{ "message": "OTP has been sent to your email" }`

**Resend OTP** (reuses the same OTP if a valid unconsumed token still exists; otherwise issues a new one)

```
curl -X POST "http://localhost:3000/api/auth/forget-password/resend" \
  -H "Content-Type: application/json" \
  -d '{ "email": "employee@example.com" }'
```

**Verify OTP** (returns a short-lived `reset_token`, valid 15 minutes)

```
curl -X POST "http://localhost:3000/api/auth/forget-password/verify-otp" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "employee@example.com",
    "otp": "1234"
  }'
```

- **400** for invalid/expired OTP or unknown email (generic message).
- **200** `{ "message": "OTP verified successfully", "reset_token": "<jwt>" }`

**Set new password** (use `reset_token` from verify-otp)

```
curl -X POST "http://localhost:3000/api/auth/forget-password/reset" \
  -H "Content-Type: application/json" \
  -d '{
    "reset_token": "<reset_token_from_verify_otp>",
    "newPassword": "NewSecure@123"
  }'
```

- **401** for invalid or expired `reset_token`.
- **400** for invalid request body or consumed/expired reset session.
- **200** `{ "message": "Password has been reset successfully" }` on success.

**Msg91:** create template id `otp_verification_email_template` with variables `ORG_NAME`, `USER_NAME`, `OTP_CODE`, `OTP_VALIDITY` (e.g. `OTP_VALIDITY` = `10 minutes`). Email is sent from `no-reply@hr-suite.shlokasolutions.app`; requires `MSG91_AUTH_KEY` in the environment.

## Step 21b: Update Personal Info and Bank Details (Employee Self-Service)

Employees can update their personal information and bank details through this API. This is accessible to all authenticated users (employees, managers, HR, admins) to update their own information.

```
curl -X PUT "http://localhost:3000/api/users/me/personal-info" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{
    "personal_info": {
      "gender": "FEMALE",
      "marital_status": "SINGLE",
      "dob": "1993-03-28",
      "nationality": "Indonesian",
      "personal_email": "mia.torres@personal.com",
      "personal_phone": "+62 812-3456-7890",
      "alt_phone": "+62 812-9999-8888"
    },
    "bank_details": {
      "account_holder_name": "Mia Torres",
      "account_number": "1234567890",
      "ifsc_code": "BANK0001234",
      "bank_name": "Bank Indonesia",
      "branch_name": "Yogyakarta Branch",
      "account_type": "SAVINGS"
    },
    "addresses": [
      {
        "type": "PRESENT",
        "street_address": "Jl. Melati No. 45",
        "city": "Sleman",
        "state": "Yogyakarta",
        "zip_code": "55584",
        "country": "Indonesia"
      },
      {
        "type": "PERMANENT",
        "street_address": "Jl. Merdeka No. 123",
        "city": "Jakarta",
        "state": "DKI Jakarta",
        "zip_code": "10110",
        "country": "Indonesia"
      }
    ]
  }'
```

**Request Body:**
- `personal_info` (optional): Object containing:
  - `gender`: Optional enum (`MALE`, `FEMALE`, `OTHER`)
  - `marital_status`: Optional enum (`SINGLE`, `MARRIED`, `DIVORCED`)
  - `dob`: Optional string in `YYYY-MM-DD` format
  - `nationality`: Optional string
  - `personal_email`: Optional string (valid email format)
  - `personal_phone`: Optional string
  - `alt_phone`: Optional string
- `bank_details` (optional): Object containing:
  - `account_holder_name`: Optional string
  - `account_number`: Optional string
  - `ifsc_code`: Optional string
  - `bank_name`: Optional string
  - `branch_name`: Optional string
  - `account_type`: Optional enum (`SAVINGS`, `CURRENT`, `SALARY`). Defaults to `SALARY` if not provided when creating new bank details.
- `addresses` (optional): Array of address objects. Each address requires:
  - `type`: Required enum (`PRESENT`, `PERMANENT`)
  - `street_address`: Optional string
  - `city`: Optional string
  - `state`: Optional string
  - `zip_code`: Optional string
  - `country`: Optional string
  - Note: Addresses are matched by `type`. If an address with the same type exists, it will be updated. Otherwise, a new address will be created.

**Expected Response:** HTTP 200 with:
```json
{
  "message": "Personal information and bank details updated successfully",
  "personal_info": {
    "gender": "FEMALE",
    "marital_status": "SINGLE",
    "dob": "1993-03-28",
    "nationality": "Indonesian",
    "personal_email": "mia.torres@personal.com",
    "personal_phone": "+62 812-3456-7890",
    "alt_phone": "+62 812-9999-8888"
  },
  "bank_details": {
    "account_holder_name": "Mia Torres",
    "account_number": "1234567890",
    "ifsc_code": "BANK0001234",
    "bank_name": "Bank Indonesia",
    "branch_name": "Yogyakarta Branch",
    "account_type": "SAVINGS"
  },
  "addresses": [
    {
      "type": "PRESENT",
      "street_address": "Jl. Melati No. 45",
      "city": "Sleman",
      "state": "Yogyakarta",
      "zip_code": "55584",
      "country": "Indonesia"
    },
    {
      "type": "PERMANENT",
      "street_address": "Jl. Merdeka No. 123",
      "city": "Jakarta",
      "state": "DKI Jakarta",
      "zip_code": "10110",
      "country": "Indonesia"
    }
  ]
}
```

**Notes:**
- `personal_info`, `bank_details`, and `addresses` are all optional - you can update one, two, or all three.
- If a profile, bank detail, or address doesn't exist, it will be created.
- If they exist, only the provided fields will be updated (partial updates supported).
- For addresses: If an address with the same `type` (PRESENT or PERMANENT) already exists, it will be updated. Otherwise, a new address will be created.
- Empty strings are converted to `undefined` (treated as not provided).
- Only the authenticated user can update their own information.
- All fields in all objects are optional, allowing partial updates.

## Step 21c: Get Employee Profile (Admin/HR)

Get employee profile information for the admin profile card view. Returns basic employee info, employment details, and personal information.

```
curl -X GET "http://localhost:3000/api/users/{{userId}}" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Path Parameters:
- `userId`: User UUID

Expected: HTTP 200 with employee profile data:

```json
{
  "employee": {
    "id": "uuid",
    "employee_id": "EMP-0289",
    "full_name": "Mia Torres",
    "first_name": "Mia",
    "last_name": "Torres",
    "role": "employee",
    "designation": "HR Officer",
    "department": {
      "id": "uuid",
      "name": "Human Resources"
    },
    "profile_image_url": null
  },
  "employment_details": {
    "employment_type": "FULL_TIME",
    "work_mode": "HYBRID",
    "join_date": "14 February 2033"
  },
  "personal_info": {
    "gender": "FEMALE",
    "date_of_birth": "28 March 1993",
    "email": "mia.torres@company.com",
    "phone": "+62 812-3456-7890",
    "address": "Jl. Melati No. 45, Sleman, Yogyakarta, Indonesia"
  }
}
```

Notes:
- Only accessible to `admin` and `hr` roles.
- Returns HTTP 404 if employee not found or doesn't belong to the organization.
- `join_date` and `date_of_birth` are formatted as "DD Month YYYY" (e.g., "14 February 2033").
- `address` is formatted from the PRESENT address (or PERMANENT if PRESENT is not available), combining all address fields with commas.
- `email` uses `personal_email` from profile if available, otherwise falls back to `official_email`.
- All fields may be `null` if not set.
- `employee.status` reflects employment state (`ACTIVE`, `ON_NOTICE`, `INACTIVE`, etc.).
- `exit` is `null` when no active exit record exists; otherwise includes notice/completion fields from `user_exits`.

## Step 21c-exit: Employee Exit Flow (Admin/HR)

Offboard an employee **without deleting** the `users` row. Leave, attendance, payroll, and document history remain linked to the same `user_id`. The API never sets `users.deleted_at` on exit.

**Paths:**
1. **Notice period:** `POST /exit` (initiate) → if `last_working_day` is **before today (IST)**, exit completes immediately; if `notice_start_date` is **after today (IST)**, exit is **`SCHEDULED`** and user stays **`ACTIVE`** until that date; otherwise `ON_NOTICE` through `last_working_day` → optional confirm or scheduler auto-complete after `last_working_day`.
2. **Immediate:** `POST /exit/immediate` — optional `last_working_day` (YYYY-MM-DD), same as `POST /exit`; when omitted, server uses **today (IST)** → `INACTIVE` in one step.
3. **Cancel notice:** `POST /exit/cancel` → back to `ACTIVE`.

Replace `{{userId}}` with the employee UUID. All routes require `admin` or `hr` and Token B.

### Preview exit (warnings)

```
curl -X GET "http://localhost:3000/api/users/{{userId}}/exit/preview" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Expected: HTTP 200 with `warnings` (pending leave, attendance corrections, helpdesk tickets, managed departments if manager) and `active_exit` if a notice/completed exit exists.

### Get current exit record

```
curl -X GET "http://localhost:3000/api/users/{{userId}}/exit" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Expected: HTTP 200, `{ "exit": { ... } | null }`.

### Initiate notice-period exit

```
curl -X POST "http://localhost:3000/api/users/{{userId}}/exit" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -H "Content-Type: application/json" \
  -d '{
    "exit_type": "RESIGNATION",
    "exit_reason": "Personal reasons",
    "notice_start_date": "2026-05-01",
    "last_working_day": "2026-05-31"
  }'
```

`exit_type`: `RESIGNATION` | `TERMINATION` | `RETIREMENT` | `END_OF_CONTRACT` | `OTHER`.

Expected: HTTP 201.

- If `last_working_day` is **before today (IST):** exit completes in the same response (`COMPLETED`, user `INACTIVE`, tokens revoked). Activity log: `EXIT_CONFIRMED` with `completed_on_initiate: true`.
- If `notice_start_date` is **after today (IST)** (and LWD is not in the past): exit `status` → **`SCHEDULED`**, user stays **`ACTIVE`** (full app access until notice starts). Activity log: `EXIT_SCHEDULED`. User remains in `GET /api/users?status=ACTIVE` lists.
- Otherwise (no future notice start): user `status` → `ON_NOTICE`; employee can log in through the last working day; **no** token revocation at initiate. Activity log: `EXIT_INITIATED`.

`notice_start_date` must be on or before `last_working_day` when both are provided.

### Deferred notice start (scheduler, no API call)

When `notice_start_date` is reached (IST calendar date), the daily scheduler sets exit and user to `ON_NOTICE`. Activity log: `EXIT_NOTICE_STARTED`. If `PATCH /exit` moves `notice_start_date` to today or earlier while still `SCHEDULED`, notice starts immediately in that request.

**Quick test:** initiate with `notice_start_date` = tomorrow, `last_working_day` = next month → `SCHEDULED`, user `ACTIVE`. After that date (server startup or next daily run) → `ON_NOTICE`.

### Auto-complete after last working day (scheduler, no API call)

When the IST calendar date moves **past** `last_working_day` (i.e. starting the next day), an in-process daily scheduler automatically runs the same finalize logic as confirm:

- `user_exits.status` → `COMPLETED`, `exited_at` / `confirmed_at` set at run time
- `users.status` → `INACTIVE`
- Refresh tokens revoked, password-reset tokens consumed, push tokens disabled
- Future pending leave after `last_working_day` auto-rejected
- Activity log: `EXIT_AUTO_CONFIRMED` (`confirmed_by` is null)

The job runs on server startup (catches backlog) and once every 24 hours while the process is running. Manual `POST /exit/confirm` is optional and can be used before the last working day.

**Quick test (past LWD on initiate):** `POST /exit` with `last_working_day` = yesterday (IST) → response shows `COMPLETED` and user is `INACTIVE` immediately (no confirm, no server restart).

**Quick test (scheduler):** initiate with `last_working_day` = today, wait until tomorrow (or restart after midnight IST) → scheduler sets `INACTIVE`.

### Update exit (scheduled or on notice)

```
curl -X PATCH "http://localhost:3000/api/users/{{userId}}/exit" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -H "Content-Type: application/json" \
  -d '{"last_working_day": "2026-06-15"}'
```

Expected: HTTP 200 with updated exit. Allowed while exit is `SCHEDULED` or `ON_NOTICE`. Moving `notice_start_date` to today or earlier while `SCHEDULED` starts notice in the same response.

### Confirm exit (end notice, optional)

```
curl -X POST "http://localhost:3000/api/users/{{userId}}/exit/confirm" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Expected: HTTP 200. User `status` → `INACTIVE`, `user_exits.status` → `COMPLETED`, `exited_at` set. Refresh tokens revoked, password-reset tokens consumed, push device tokens disabled. Pending leave with `start_date` after `last_working_day` is auto-rejected. Activity log: `EXIT_CONFIRMED`. If you do not call this, the scheduler completes the exit the day after `last_working_day` (see auto-complete above).

### Immediate exit (skip notice)

```
curl -X POST "http://localhost:3000/api/users/{{userId}}/exit/immediate" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -H "Content-Type: application/json" \
  -d '{
    "exit_type": "TERMINATION",
    "exit_reason": "Policy violation",
    "last_working_day": "2026-05-20"
  }'
```

`last_working_day` is **optional**. Format: **YYYY-MM-DD** (same as `POST /exit`). When omitted, the server sets it to **today (IST)**.

Expected: HTTP 200. Same final state as confirm (inactive + revoke + `exited_at`) without an `ON_NOTICE` phase. Response `exit.last_working_day` matches the body value or today (IST) when omitted.

### Cancel exit (scheduled or on notice)

```
curl -X POST "http://localhost:3000/api/users/{{userId}}/exit/cancel" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Expected: HTTP 200, exit row `CANCELLED`. If exit was `ON_NOTICE`, user returns to `ACTIVE`. If exit was `SCHEDULED`, user was already `ACTIVE`.

### List / statistics after exit

- `GET /api/users?status=ACTIVE` — excludes `INACTIVE` and `ON_NOTICE` employees.
- `GET /api/users?status=INACTIVE` or `status=ALL` — includes separated employees; history APIs (`/details`, `/payrolls`, `/leaves`) still work because `deleted_at` is unchanged.
- Turnover / resigned counts use `user_exits.exited_at` for new exits; legacy `INACTIVE` + `updated_at` still counts when no completed exit row exists.

### Guards

- Cannot exit `admin` or `device` roles.
- Cannot initiate twice while an active exit (`ON_NOTICE` or `COMPLETED`) exists.
- Cannot confirm unless user is `ON_NOTICE`.

## Step 21c.1: Get Employee Details (Comprehensive Dashboard) (Admin/HR)

Get comprehensive employee details including profile, employment info, leave summary, hours logged, documents, calendar, and payroll summary. This is a single API that aggregates all employee data for the admin dashboard view.

```
curl -X GET "http://localhost:3000/api/users/{{userId}}/details?month=6&year=2035" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Query Parameters:
- `month` (optional): Month number (1-12), defaults to current month
- `year` (optional): Year (2000-2100), defaults to current year

Path Parameters:
- `userId`: User UUID

Expected: HTTP 200 with comprehensive employee data:

```json
{
  "employee": {
    "id": "uuid",
    "employee_id": "EMP-0289",
    "full_name": "Mia Torres",
    "first_name": "Mia",
    "last_name": "Torres",
    "role": "employee",
    "designation": "HR Officer",
    "department": {
      "id": "uuid",
      "name": "Human Resources"
    },
    "status": "ACTIVE",
    "profile_image_url": null
  },
  "employment_details": {
    "employment_type": "FULL_TIME",
    "work_mode": "HYBRID",
    "join_date": "14 February 2033"
  },
  "social_media": {
    "linkedin": null,
    "twitter": null,
    "instagram": null
  },
  "personal_info": {
    "gender": "FEMALE",
    "date_of_birth": "28 March 1993",
    "email": "mia.torres@company.com",
    "phone": "+62 812-3456-7890",
    "address": "Jl. Melati No. 45, Sleman, Yogyakarta, Indonesia"
  },
  "leave_summary": {
    "all_leaves": {
      "used": 14,
      "quota": 20,
      "percentage": 70
    },
    "paid_leaves": {
      "used": 10,
      "quota": 15,
      "percentage": 66
    },
    "casual_leaves": {
      "used": 1,
      "quota": 5,
      "percentage": 20
    },
    "sick_leaves": {
      "used": 3,
      "quota": 4,
      "percentage": 75
    }
  },
  "hours_logged": {
    "total_hours": 34,
    "total_minutes": 30,
    "total_seconds": 124200,
    "daily": [
      { "day": "M", "hours": 8, "minutes": 0 },
      { "day": "T", "hours": 7, "minutes": 30 },
      { "day": "W", "hours": 4, "minutes": 0 },
      { "day": "T", "hours": 8, "minutes": 0 },
      { "day": "F", "hours": 7, "minutes": 0 },
      { "day": "S", "hours": 0, "minutes": 0 },
      { "day": "S", "hours": 0, "minutes": 0 }
    ]
  },
  "documents": [
    {
      "name": "Performance Evaluation.pdf",
      "size": "1.24 MB",
      "url": "https://...",
      "category": "EXPERIENCE",
      "type": "PERFORMANCE_EVALUATION"
    },
    {
      "name": "Contract Agreement.pdf",
      "size": "895 KB",
      "url": "https://...",
      "category": "LEGAL",
      "type": "CONTRACT_AGREEMENT"
    }
  ],
  "calendar": {
    "month": 6,
    "year": 2035,
    "entries": [
      { "date": "2035-06-01", "status": "PRESENT" },
      { "date": "2035-06-02", "status": "LATE" },
      { "date": "2035-06-03", "status": "PRESENT" },
      { "date": "2035-06-19", "status": "ON_LEAVE" },
      { "date": "2035-06-20", "status": "ON_LEAVE" }
    ],
    "legend": {
      "present": 13,
      "late": 5,
      "on_leave": 2,
      "absent": 1
    }
  },
  "performance_overview": {},
  "internal_notes": {},
  "payroll_summary": {
    "total_records": 12,
    "latest_payroll": {
      "id": "uuid",
      "month": 6,
      "year": 2024,
      "date": "2024-06-01",
      "gross_salary": 50000,
      "net_salary": 51000,
      "status": "PAID",
      "payslip_url": "https://..."
    },
    "average_net_salary": 50500,
    "total_earnings": 612000,
    "total_deductions": 60000
  }
}
```

Notes:
- Only accessible to `admin` and `hr` roles.
- `leave_summary` calculates balances for the current year based on approved and pending leave requests (days counted as working days per department schedule, excluding org holidays that are enabled for that employee—not raw calendar days).
- `hours_logged` shows data for the current week (Monday to Sunday).
- `calendar` shows attendance status for the specified month/year.
- `payroll_summary` includes total records, latest payroll details, average net salary, total earnings, and total deductions.
- `performance_overview` and `internal_notes` are returned as empty objects (not yet implemented).
- Leave types are automatically categorized into "paid", "casual", and "sick" based on leave type name (case-insensitive matching).

## Step 21d: Department Employee Summary (Upper Cards) (Admin/HR)

Get dashboard summary cards for a specific department showing department name, manager_ids, managers, total employees, and new employees statistics with percentage changes from last month.

```
curl -X GET "http://localhost:3000/api/departments/{{deptId}}/summary" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Path Parameters:
- `id`: Department UUID (e.g., `{{deptId}}`)

Expected: HTTP 200 with summary cards data:

```json
{
  "department": {
    "id": "uuid",
    "name": "Marketing"
  },
  "manager_ids": ["uuid"],
  "managers": [
    {
      "id": "uuid",
      "full_name": "Suraj Shetty"
    }
  ],
  "total_employees": {
    "count": 128,
    "change_percentage": 1.6,
    "change_display": "+1.6%"
  },
  "new_employees_this_month": {
    "count": 7,
    "change_percentage": 5.8,
    "change_display": "+5.8%"
  }
}
```

Notes:
- Only accessible to `admin` and `hr` roles.
- Returns HTTP 404 if department not found or doesn't belong to the organization.
- `department` is always present (from path parameter).
- `manager_ids` is an empty array when no manager is assigned.
- `managers` is an empty array when no manager is assigned.
- `total_employees` shows count of active employees in this department (role='employee', status='ACTIVE', not soft-deleted).
- `new_employees_this_month` shows count of employees created in the current month for this department.
- Percentage changes are calculated by comparing current month with previous month.

## Step 21e: Department Employee List (Lower Table) (Admin/HR)

Get paginated employee list table for a specific department with all employee details including employment type, work mode, join date, and status. Supports filtering, searching, and sorting.

```
curl -X GET "http://localhost:3000/api/departments/{{deptId}}/employees?page=1&limit=10&status=ALL&sort_by=NAME&sort_dir=ASC" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Path Parameters:
- `id`: Department UUID (e.g., `{{deptId}}`)

Query Parameters:
- `page` (optional): Page number (default `1`, min `1`, max `10000`)
- `limit` (optional): Page size (default `10`, min `1`, max `100`)
- `status` (optional): `ACTIVE|INACTIVE|ON_NOTICE|ALL` (default: `ALL`)
- `employment_type` (optional): `FULL_TIME|PART_TIME|CONTRACT|INTERNSHIP|FREELANCE`
- `work_mode` (optional): `ONSITE|HYBRID|REMOTE`
- `search` (optional): Case-insensitive search across `employee_id`, name, and email
- `sort_by` (optional): `NAME|JOIN_DATE|STATUS|EMPLOYMENT_TYPE|WORK_MODE` (default: `NAME`)
- `sort_dir` (optional): `ASC|DESC` (default: `ASC`)

Expected: HTTP 200 with paginated employee list:

```json
{
  "page": 1,
  "limit": 10,
  "total": 480,
  "total_pages": 48,
  "data": [
    {
      "id": "uuid",
      "employee_id": "EMP-0234",
      "name": "Olivia Mason",
      "job_title": "Marketing Specialist",
      "employment_type": "FULL_TIME",
      "work_mode": "HYBRID",
      "join_date": "2034-01-12",
      "status": "ACTIVE",
      "profile_image_url": null
    },
    {
      "id": "uuid",
      "employee_id": "EMP-0178",
      "name": "Ethan Ray",
      "job_title": "UI Designer",
      "employment_type": "FULL_TIME",
      "work_mode": "REMOTE",
      "join_date": "2033-03-03",
      "status": "ACTIVE",
      "profile_image_url": null
    }
  ]
}
```

Notes:
- Only accessible to `admin` and `hr` roles.
- Returns HTTP 404 if department not found or doesn't belong to the organization.
- Returns only employees in the specified department (role='employee'), excluding soft-deleted records.
- `employment_type` and `work_mode` come from `employee_employment_details` table and may be `null` if not set.
- `job_title` is the `designation` field from the `users` table.
- `department` field is **not included** in the response since all employees belong to the same department (specified in the URL path parameter).
- Search matches across employee_id, first_name, last_name, full_name (concatenated), and official_email.
- Sorting by `NAME` sorts by first_name then last_name.

---

## Step 21f: Employee Documents List (Admin/HR)

Get paginated list of documents for a specific employee with filtering, search, and sorting capabilities.

```
curl -X GET "http://localhost:3000/api/users/{{userId}}/documents?page=1&limit=10&category=IDENTITY&status=VERIFIED&search=PAN&sort_by=UPLOADED_DATE&sort_dir=DESC" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Path Parameters:
- `userId`: User UUID

Query Parameters:
- `page` (optional, default: 1): Page number (1-10000)
- `limit` (optional, default: 10): Items per page (1-100)
- `category` (optional): Filter by document category (`IDENTITY`, `EDUCATION`, `EXPERIENCE`, `FINANCE`, `LEGAL`)
- `status` (optional): Filter by verification status (`PENDING`, `VERIFIED`, `REJECTED`)
- `search` (optional): Search across document name and category
- `sort_by` (optional, default: `UPLOADED_DATE`): Sort field (`NAME`, `CATEGORY`, `UPLOADED_DATE`, `STATUS`)
- `sort_dir` (optional, default: `DESC`): Sort direction (`ASC`, `DESC`)

Expected Response (HTTP 200):
```json
{
  "page": 1,
  "limit": 10,
  "total": 5,
  "total_pages": 1,
  "data": [
    {
      "id": "uuid",
      "document_name": "PAN_CARD",
      "category": "IDENTITY",
      "uploaded_date": "Today, 10:30 AM",
      "view": "https://example.com/pan-card.png",
      "status": "VERIFIED"
    },
    {
      "id": "uuid",
      "document_name": "AADHAAR_CARD",
      "category": "IDENTITY",
      "uploaded_date": "12/01/2026, 10:30 AM",
      "view": "https://example.com/aadhaar-card.png",
      "status": "PENDING"
    }
  ]
}
```

Notes:
- Only accessible to `admin` and `hr` roles.
- `uploaded_date` is formatted as "Today, HH:MM AM/PM" for today's uploads, otherwise "DD/MM/YYYY, HH:MM AM/PM".
- Returns HTTP 404 if employee not found.

---

## Step 21g: Employee Leaves (Summary + Calendar) (Admin/HR)

Get leave summary cards and calendar data for a specific employee.

```
curl -X GET "http://localhost:3000/api/users/{{userId}}/leaves?month=6&year=2035" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Path Parameters:
- `userId`: User UUID

Query Parameters:
- `month` (optional, default: current month): Month number (1-12)
- `year` (optional, default: current year): Year (2000-2100)

Expected Response (HTTP 200):
```json
{
  "leave_summary": {
    "all_leaves": {
      "used": 14,
      "quota": 20
    },
    "paid_leaves": {
      "used": 10,
      "quota": 15
    },
    "casual_leaves": {
      "used": 1,
      "quota": 5
    },
    "sick_leaves": {
      "used": 3,
      "quota": 4
    }
  },
  "calendar": {
    "month": 6,
    "year": 2035,
    "entries": [
      { "date": "2035-06-01", "status": "ON_LEAVE" },
      { "date": "2035-06-02", "status": "PRESENT" },
      { "date": "2035-06-03", "status": "PRESENT" },
      { "date": "2035-06-04", "status": "LATE" },
      { "date": "2035-06-05", "status": "PRESENT" },
      { "date": "2035-06-13", "status": "ABSENT" }
    ],
    "legend": {
      "present": 13,
      "late": 5,
      "on_leave": 2,
      "absent": 1
    }
  }
}
```

Notes:
- Only accessible to `admin` and `hr` roles.
- Leave summary calculates balances for the specified year based on approved and pending leave requests (working days per department schedule, excluding org holidays enabled for that employee after per-user overrides).
- Leave types are automatically categorized into "paid", "casual", and "sick" based on leave type name (case-insensitive matching).
- Calendar shows attendance status for the specified month/year.
- Calendar statuses: `PRESENT`, `LATE`, `ON_LEAVE`, `ABSENT`.
- Returns HTTP 404 if employee not found.

## Step 21g2: Per-user Org Holiday Enable/Disable (Admin/HR/Manager)

Toggle whether a specific org holiday applies to one employee. Org holidays remain the source of truth; absence of an override means **enabled**. Disabling a holiday for a user makes that date a normal scheduled day for attendance, leave day counts, payslip LOP, OT, and notifications — it does **not** delete the org holiday or rewrite historical rows.

### List holidays for a user

```
curl -X GET "http://localhost:3000/api/users/{{userId}}/holidays" \
  -H "Authorization: Bearer <TOKEN>"
```

Expected Response (HTTP 200):
```json
{
  "items": [
    {
      "id": "<holiday-uuid>",
      "holiday_ids": ["<holiday-uuid>"],
      "from_date": "2026-10-02",
      "to_date": "2026-10-02",
      "title": "Gandhi Jayanti",
      "dates": [
        { "holiday_id": "<holiday-uuid>", "date": "2026-10-02", "enabled": true }
      ]
    }
  ]
}
```

### Update overrides

```
curl -X PUT "http://localhost:3000/api/users/{{userId}}/holidays" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      { "holiday_id": "<holiday-uuid>", "enabled": false }
    ]
  }'
```

Expected Response (HTTP 200):
```json
{
  "message": "User holiday overrides updated successfully",
  "updated_count": 1
}
```

Notes:
- Roles: `admin` / `hr` — any user in the org; `manager` — only `employee` users in managed departments (403 otherwise).
- Toggle by `holiday_id` (one DB row = one date). For multi-day ranges, send every id from `holiday_ids` / `dates`.
- Org calendar CRUD stays on `GET/POST/DELETE /api/holidays` (admin only).

## Step 21h: Employee Payrolls (Admin/HR)

Get paginated list of payroll records for a specific employee.

```
curl -X GET "http://localhost:3000/api/users/{{userId}}/payrolls?page=1&limit=10&month=6&year=2024&status=PAID" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Path Parameters:
- `userId`: User UUID

Query Parameters:
- `page` (optional, default: 1): Page number (1-10000)
- `limit` (optional, default: 10): Items per page (1-100)
- `month` (optional): Filter by payroll month (1-12)
- `year` (optional): Filter by payroll year (2000-2100)
- `status` (optional): Filter by status (`PENDING`, `ADJUSTED`, `PAID`, `DRAFT`, `PROCESSED`, `CANCELLED`)

Expected Response (HTTP 200):
```json
{
  "page": 1,
  "limit": 10,
  "total": 12,
  "total_pages": 2,
  "data": [
    {
      "id": "uuid",
      "month": 6,
      "year": 2024,
      "date": "2024-06-01",
      "gross_salary": 50000,
      "allowances": 3000,
      "overtime": 2000,
      "incentives": 1000,
      "deductions": 5000,
      "net_salary": 51000,
      "status": "PAID",
      "payslip_url": "https://...",
      "created_at": "2024-06-01T00:00:00.000Z",
      "updated_at": "2024-06-01T00:00:00.000Z"
    }
  ]
}
```

Notes:
- Only accessible to admin and hr roles.
- Records are sorted by date (most recent first).
- Returns payroll records with all financial details and status information.

---

## Step 22a: Admin Dashboard (Admin/HR/Manager)

Get comprehensive admin dashboard data including summary cards, employee attendance, employment status, calendar, and attendance report. This is a single API that aggregates all dashboard data for the admin view.

```
curl -X GET "http://localhost:3000/api/dashboard?month=6&year=2035&date=2035-06-19" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Query Parameters:
- `month` (optional): Month number (1-12), defaults to current month
- `year` (optional): Year (2000-2100), defaults to current year
- `date` (optional): Specific date (YYYY-MM-DD) for employee attendance table, defaults to today

Expected: HTTP 200 with comprehensive dashboard data:

```json
{
  "summary_cards": {
    "total_employees": {
      "count": 128,
      "message": "You're part of a growing team!"
    },
    "attendance": {
      "percentage": 92,
      "present": "Present",
      "days_off": 3,
      "late_arrivals": 1,
      "message": "Your attendance this month is looking solid"
    },
    "leave_requests": {
      "approved": 1,
      "pending_review": 1,
      "total": 2,
      "message": "You've submitted 2 leave requests this month"
    },
    "job_applicants": {}
  },
  "employee_attendance": {
    "summary": {
      "on_time": 82,
      "late": 11,
      "on_leave": 6,
      "absent": 3
    },
    "table": [
      {
        "name": "Olivia Mason",
        "job_title": "Executive Marketing",
        "date": "2035-06-19",
        "check_in": "08:55 AM",
        "check_out": "05:05 PM",
        "status": "On-Time"
      },
      {
        "name": "Ethan Ray",
        "job_title": "Product Design",
        "date": "2035-06-19",
        "check_in": "09:14 AM",
        "check_out": "05:20 PM",
        "status": "Late"
      },
      {
        "name": "Lina Armand",
        "job_title": "R&D",
        "date": "2035-06-19",
        "check_in": null,
        "check_out": null,
        "status": "On Leave"
      },
      {
        "name": "Jacob Yuen",
        "job_title": "Operations",
        "date": "2035-06-19",
        "check_in": null,
        "check_out": null,
        "status": "Absent"
      }
    ],
    "period": {
      "month": 6,
      "year": 2035,
      "date": "2035-06-19"
    }
  },
  "employment_status": {
    "total_employees": 128,
    "breakdown": [
      {
        "type": "full_time",
        "label": "Full-Time",
        "count": 87,
        "percentage": 68
      },
      {
        "type": "part_time",
        "label": "Part-Time",
        "count": 19,
        "percentage": 15
      },
      {
        "type": "freelance",
        "label": "Freelance",
        "count": 13,
        "percentage": 10
      },
      {
        "type": "internship",
        "label": "Internship",
        "count": 9,
        "percentage": 7
      }
    ]
  },
  "calendar": {
    "month": 6,
    "year": 2035,
    "entries": [
      {
        "date": "2035-06-01",
        "highlighted": false
      },
      {
        "date": "2035-06-04",
        "highlighted": true
      },
      {
        "date": "2035-06-08",
        "highlighted": true
      }
    ]
  },
  "attendance_report": {
    "attendance_rate": 92,
    "change_percentage": 1.54,
    "change_display": "+1.54%",
    "heatmap": [
      {
        "time": "8:00 AM",
        "day": "Monday",
        "count": 45,
        "intensity": 100
      },
      {
        "time": "8:00 AM",
        "day": "Tuesday",
        "count": 42,
        "intensity": 93
      },
      {
        "time": "8:30 AM",
        "day": "Monday",
        "count": 38,
        "intensity": 84
      }
    ],
    "period": {
      "month": 6,
      "year": 2035
    }
  },
  "schedules": {},
  "team_performance": {},
  "employee_satisfaction": {},
  "tasks": {},
  "recent_activities": {}
}
```

Notes:
- Only accessible to `admin`, `hr`, and `manager` roles.
- `summary_cards.attendance.present` is a label string ("Present").
- `employee_attendance.table` shows data for the specific `date` parameter (defaults to today).
- `employee_attendance.summary` shows counts for the specific date.
- `calendar.entries[].highlighted` indicates dates with attendance activity.
- `attendance_report.heatmap` shows attendance intensity by time slot (8:00 AM - 10:30 AM) and day of week (Mon-Fri).
- `attendance_report.change_display` shows formatted change percentage (e.g., "+1.54%").
- `schedules`, `team_performance`, `employee_satisfaction`, `tasks`, and `recent_activities` are returned as empty objects (not yet implemented).

## Step 23: Department-wise User Distribution (Admin/HR)
Get department-wise user counts + percentage distribution for the current org (useful for dashboards like “Departments” donut chart).
```
curl -X GET "http://localhost:3000/api/departments/statistics" \
  -H "Authorization: Bearer <TOKEN_B>"
```
Optional query parameters:
- `role` = `admin|hr|manager|employee`
- `status` = `ACTIVE|INACTIVE|ON_NOTICE|ALL` (default: `ACTIVE`)
- `include_unassigned` = `true|false` (default: `true`)
- `include_empty` = `true|false` (default: `false`)

Expected: HTTP 200, JSON like:
- `total_users`
- `departments`: array of `{ department_id, department_name, user_count, percentage }`
- `unassigned`: `{ department_id: null, department_name: "Unassigned", user_count, percentage }` (when `include_unassigned=true`)

## Step 23a: Departments Dashboard (Admin/HR)

Single API to power the “Departments” section of the admin dashboard (summary cards + donut chart), similar to the screenshot with **Total Departments**, **New Departments (This Month)**, **Turnover Rate**, and the departments donut.

```
curl -X GET "http://localhost:3000/api/departments/dashboard?month=6&year=2035" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Query parameters:
- `month`: Optional integer `1-12`. Defaults to current month when omitted.
- `year`: Optional integer `2000-2100`. Defaults to current year when omitted.
- `role`: Optional `admin|hr|manager|employee` to filter user-based stats and distribution.
- `status`: Optional `ACTIVE|INACTIVE|ON_NOTICE|ALL` (default: `ACTIVE`) for user-based distribution.
- `include_unassigned`: Optional `true|false` (default: `true`) – whether to add an “Unassigned” slice in the donut.
- `include_empty`: Optional `true|false` (default: `false`) – whether to include departments with 0 users in the donut.

Expected: HTTP 200, JSON:
- `summary`:
  - `total_departments`: Active (non-deleted) departments in the org at present.
  - `total_departments_change_pct_from_last_month`: Percentage change vs. end of previous month.
  - `new_departments_this_month`: Departments created in the selected month.
  - `new_departments_change_pct_from_last_month`: Percentage change vs. previous month.
  - `closed_departments_this_month`: Departments soft-deleted (`deleted_at` set) in the selected month.
  - `closed_departments_change_pct_from_last_month`: Percentage change vs. previous month.
  - `turnover_rate`: Organization turnover rate for the selected month, computed as `(resigned users this month / total users now) × 100`, rounded to 2 decimals.
  - `turnover_rate_change_pct_from_last_month`: Change in turnover rate vs. previous month.
- `distribution`:
  - `total_users`: Total users considered for the donut (respecting `role`, `status`, and deletion).
  - `departments[]`: `{ department_id, department_name, user_count, percentage }` for each department.
  - `unassigned`: When `include_unassigned=true`, `{ department_id: null, department_name: "Unassigned", user_count, percentage }`.
- `period`: `{ month, year, start_date, end_date }` for the selected month.
- `compare_period`: `{ month, year, start_date, end_date }` for the previous month.
- `filter`: Echoes the applied filters `{ role, status, include_unassigned, include_empty }`.

## Step 24: Departments List (Optional)
```
curl -X GET http://localhost:3000/api/departments \
  -H "Authorization: Bearer <TOKEN_B>"
```
Expected: HTTP 200, array of departments. Each item includes:
- `id`, `name`, `org_id`
- `location`, `defaultShift`, `manager_ids`, `managers`
- `employee_count`: Total number of users in the org currently assigned to that department (excluding soft-deleted users).
- `created_on`: Department creation timestamp.
- `status`: `ACTIVE` when `deleted_at` is null, otherwise `INACTIVE`.

## Step 24a: Update Department Manager and Employees (Token B)

Use the unified update endpoint to change basic department details, managers, and employees in a single RESTful call.

```
curl -X PUT http://localhost:3000/api/departments/<dept_id_from_step_8> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "name":"Engineering",
    "location_id":"<optional_location_id>",
    "default_shift_id":"<optional_shift_id>",
    "manager_ids":["<optional_manager_user_id_1>","<optional_manager_user_id_2>"],
    "employee_ids":[
      "<employee_user_id_from_step_9>",
      "<another_employee_user_id>"
    ]
  }'
```

Expected: HTTP 200 with the updated department, including `location`, `defaultShift`, `manager_ids`, `managers`, and full `users` list for the department.

**Rules:**
- `manager_ids` (when provided) follows the same rules as in Step 8:
  - Same org, non-deleted, `status: "ACTIVE"` for every manager in the array.
  - Each manager’s `department_id` is set to this department.
  - Passing an empty array clears department manager assignments.
- `employee_ids` (when provided) are treated as the **complete desired membership** for this department:
  - All listed users must exist in the org and not be soft-deleted.
  - Users currently in this department but **not** in `employee_ids` are unassigned (`department_id` set to `null`).
  - All users in `employee_ids` have their `department_id` set to this department (moving them from other departments if needed).
- If any user ID is invalid or from another org, the request fails with HTTP 400 and **no partial updates** are applied.

## Step 25: Admin Orgs List (Optional)
```
curl -X GET "http://localhost:3000/api/admin/organizations?page=1&limit=10" \
  -H "Authorization: Bearer <TOKEN_A>"
```
Expected: HTTP 200, paginated list.

## Step 26: Admin Orgs Update Status (Optional)
```
curl -X PATCH http://localhost:3000/api/admin/organizations/<org_id>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_A>" \
  -d '{"status":"INACTIVE"}'
```
Expected: HTTP 200, updated organization.

## Step 27: Create Office Location (Token B)
```
curl -X POST http://localhost:3000/api/office-locations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"name":"Headquarters","latitude":22.5726,"longitude":88.3639,"radius_meters":100,"address":"12 Park Street, Kolkata, WB 700001, India"}'
```
Expected: HTTP 201, JSON with office location `id`.
Note: `latitude` and `longitude` are required. `radius_meters` defaults to 100 if not provided. `address` is an optional human-readable string that can be used in UIs.

## Step 28: Create Work Shift (Token B)
```
curl -X POST http://localhost:3000/api/work-shifts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"name":"General Shift","start_time":"09:00:00","end_time":"18:00:00","break_duration_mins":60}'
```
Expected: HTTP 201, JSON with work shift `id`.
Note: Time format must be `HH:MM:SS`. `break_duration_mins` defaults to 60 if not provided.

## Step 29: Assign Location and Shift to Department (Token B)
Update the department to use the created location and shift.
```
curl -X PUT http://localhost:3000/api/departments/<dept_id_from_step_8> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"location_id":"<location_id_from_step_28>","default_shift_id":"<shift_id_from_step_29>"}'
```
Expected: HTTP 200, updated department with `location_id` and `default_shift_id`.
Note: This is required for attendance clock-in to work (geofencing requires department location). Both `location_id` and `default_shift_id` can be set to `null` to remove assignments.

## Step 31: Attendance - Dashboard Status (Before Clock-In)
```
curl -X GET http://localhost:3000/api/attendance/dashboard-status \
  -H "Authorization: Bearer <TOKEN_C>"
```
Expected: HTTP 200, `state: "NOT_CLOCKED_IN"`.

## Step 32: Attendance - Clock In
```
curl -X POST http://localhost:3000/api/attendance/clock-in \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"latitude":22.5726,"longitude":88.3639}'
```
Expected: HTTP 201, `attendance_log_id`.

**Geofencing behavior:**
- For employees with `work_mode = "ONSITE"` (in `employee_employment_details`), the clock-in request must be within the configured department geofence (`office-locations.radius_meters`, `latitude`, `longitude`) **or** an active `user_allowed_locations` row, or it returns HTTP 403 with `distance_meters`.
- For employees with `work_mode = "HYBRID"` or `work_mode = "REMOTE"`, geofencing is **not** enforced (unless today is an approved WFH day — see below). They can clock in from any location as long as valid `latitude` and `longitude` are provided.
- If `work_mode` is not set for an employee, the system treats them as `ONSITE` and applies geofencing.
- **Approved WFH day override:** If the employee has an `APPROVED` WFH request covering today, geofencing is **always** enforced (including for HYBRID/REMOTE). Allowed locations are the same union as ONSITE: department office locations **or** active admin-managed `user_allowed_locations`. Missing all locations → HTTP 400; outside all radii → HTTP 403.

## Step 33: Attendance - Start Break
```
curl -X POST http://localhost:3000/api/attendance/break/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"break_type":"LUNCH"}'
```
Expected: HTTP 201, `{"message":"Break started"}`.
Note: `break_type` is case-insensitive; values like `"lunch"` or `"Lunch"` are also accepted.

## Step 34: Attendance - End Break
```
curl -X POST http://localhost:3000/api/attendance/break/end \
  -H "Authorization: Bearer <TOKEN_C>"
```
Expected: HTTP 200, returns `total_break_time` and `is_excess_break`.

## Step 35: Attendance - Clock Out
```
curl -X POST http://localhost:3000/api/attendance/clock-out \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"latitude":22.5726,"longitude":88.3639}'
```
Expected: HTTP 200, `total_work_hours`.

Auto clock-out fallback for missed clock-out:
- If a user has clocked in on day `D` but has not clocked out, the system auto-finalizes that open attendance on day `D+1` on or after **4 hours before the user's shift start time** (retries each minute until closed).
- Shift resolution matches attendance APIs: user shift, then department default shift, then for managers the first managed department's default shift.
- The auto-calculated `clock_out_time` is set to day `D`'s shift end time (or next calendar day for night shifts where shift end is after midnight), and `total_work_hours` is recomputed accordingly.
- This is handled by the in-process scheduler; no manual API call is required.

## Step 35b: Attendance - Admin Dashboard (Org-Level)

Single API for the **Attendance → Admin dashboard summary cards + Attendance Overview chart** (first screenshot).

```
curl -X GET "http://localhost:3000/api/attendance/admin/dashboard?date=2035-06-19&months=6" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Query parameters:
- `date` (optional): Focus date in `YYYY-MM-DD` format. Defaults to **today** when omitted.
- `months` (optional): Integer `1-12`, how many months to include in the **Attendance Overview** stacked chart (default: `6`). The range always ends at the month of `date`.

Expected: HTTP 200 with:
- `date`: Focus date (YYYY-MM-DD)
- `months`: Number of months included in the overview
- `summary_today`:
  - `total_employees`: Active, non-deleted `employee`-role users in the org
  - `present`:
    - `count`: Employees with an attendance log on `date` who are not on full-day leave (includes half-day leave employees who clocked in)
    - `change_vs_yesterday`: Difference vs. previous day’s present count
    - `on_time`: Present employees whose first punch is **on or before** shift start
    - `late`: Present employees whose first punch is **after** shift start
    - `half_day_worked_count`: Subset of present employees on approved half-day leave (`FIRST_HALF` / `SECOND_HALF`) who have clocked in — use for a Present card subtitle such as "42 present (incl. 2 half-day)"
  - `on_leave`:
    - `count`: Employees with **full-day** approved leave on `date`
    - `change_vs_yesterday`: Difference vs. previous day’s on-leave count
    - `by_type[]`: `{ id, name, count, percentage }` — breakdown by leave type for `date`
  - `on_halfday`:
    - `count`: Employees with approved half-day leave on `date` who have **not** clocked in yet
    - `change_vs_yesterday`: Difference vs. previous day’s on-halfday count
    - `by_type[]`: `{ id, name, count, percentage }` — breakdown by leave type for half-day-no-punch only
  - `absent`:
    - `count`: Scheduled employees who are neither present nor on leave nor on half-day leave on `date`
    - `change_vs_yesterday`: Difference vs. previous day’s absent count
- `overview`:
  - `period`: `{ start_date, end_date }` (first day of earliest month to last day of focus month)
  - `by_month[]`: For each month in range:
    - `month`, `year`
    - `present_count`, `on_leave_count`, `on_halfday_count`, `absent_count`
    - `present_percentage`, `on_leave_percentage`, `on_halfday_percentage`, `absent_percentage`  
    Percentages are averaged over all days and employees in that month and always add up to ~100%.

**Admin dashboard half-day display (for frontend consumers):**
- If approved half-day leave **today** and **no clock-in** → summary card: `on_halfday`; table row `status=HALF_DAY`, `is_on_halfday_leave=true`
- If approved half-day leave **today** and **clocked in** → summary card: `present` (and `half_day_worked_count`); table row `status=ON_TIME|LATE`, `is_on_halfday_leave=true`
- If approved half-day leave on a **past date** with **no clock-in** → `status=ABSENT` (not `HALF_DAY`); dashboard `on_halfday` does not count them for that date
- Filter all half-day leave (with or without punch): `GET .../admin/users?date=...&leave_session=ANY_HALF`
- Filter only no-punch half-day on **today**: `status=HALF_DAY`

**Half-day no-punch penalty (post IST midnight):**
- Employees with approved half-day leave who never clocked in on a working day are marked **ABSENT** once the date is in the past (`date < today` in IST).
- After midnight, an in-process scheduler processes **yesterday** and, per employee/day (idempotent):
  - **Auto-cancels** the original half-day leave request (`status=CANCELLED`), restoring **0.5** to leave balance.
  - Records **1.0 LOP** in `attendance_half_day_no_punch_penalties` (same payroll impact as plain absent without leave).
- No supplemental leave is created and no leave balance is deducted beyond restoring the voided half-day request.

Notes:
- Only attendance-scoped org roles (`employee`, `hr`, `manager`) with `status` in (`ACTIVE`, `ON_NOTICE`) and `deleted_at IS NULL` are counted; `INACTIVE` users are excluded.
- Leave data comes from `leave_requests` with `status = APPROVED` whose date range overlaps the dashboard period. Full-day leave always counts as on_leave. Half-day leave without clock-in counts as on_halfday; half-day with clock-in counts as present.

### Attendance bulk import (Admin/HR)

Upload daily attendance via Excel — one row per employee per day, keyed by `official_email`.

**Required columns:** `official_email`, `date` (YYYY-MM-DD), `status` (PRESENT | ABSENT | LATE), `total_work_minutes` (0 for ABSENT; >0 for PRESENT/LATE). Optional: `overtime_minutes` (default 0).

**Sample file (repo):** [`samples/attendance_bulk_import_sample.xlsx`](samples/attendance_bulk_import_sample.xlsx) — five filled example rows (`PRESENT`, `LATE`, `ABSENT`) for July 2026. Edit `official_email` values to match employees in your org before testing. Regenerate with `npm run generate:attendance-bulk-import-sample`.

**Download template:**
```
curl -X GET "http://localhost:3000/api/attendance/admin/bulk-import/template?month=7&year=2026" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -o attendance_bulk_import_2026_07.xlsx
```

Query parameters:
- `month`, `year` (optional, both required together): Pre-fills all active org employees × each day of that month with `official_email` and `date` columns.
- Without `month`/`year`: Returns a blank template with one example row.

**Validate only (dry run):**
```
curl -X POST "http://localhost:3000/api/attendance/admin/bulk-import?dry_run=true&month=7&year=2026" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -F "file=@samples/attendance_bulk_import_sample.xlsx"
```

**Import (writes to DB):**
```
curl -X POST "http://localhost:3000/api/attendance/admin/bulk-import?month=7&year=2026" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -F "file=@samples/attendance_bulk_import_sample.xlsx"
```

Expected: HTTP 200 with:
```json
{
  "message": "Attendance import completed",
  "dry_run": false,
  "summary": {
    "total_rows": 62,
    "valid": 60,
    "created": 10,
    "updated": 50,
    "failed": 2,
    "skipped": 0
  },
  "results": [
    {
      "row": 2,
      "official_email": "anita@company.com",
      "date": "2026-07-01",
      "status": "created",
      "attendance_log_id": "..."
    }
  ]
}
```

Notes:
- Auth: **admin** or **hr** only (managers cannot import).
- `official_email` must match an active org user (`ACTIVE` or `ON_NOTICE`, not `device`).
- Duplicate `(official_email, date)` in the same file → row error.
- Re-importing the same employee+date **overwrites** the existing `attendance_logs` row (and clears breaks).
- Imported overtime is stored in `overtime_minutes` and used by calendar/Excel export when set.
- Max 5000 rows, 5 MB file size.

## Step 35a: Leave Management - Setup and Core Flows

The following steps cover the end-to-end **Leave Management** APIs used by the mobile and web UIs (apply leave, history, approvals, and dashboard).

### 35a.0: Create Leave Types (Admin/HR)

Before employees can apply for leave, admin/HR must create leave types for the organization.

**Create Casual Leave:**
```
curl -X POST http://localhost:3000/api/leaves/types \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"name":"Casual Leave","annual_quota":12}'
```

**Create Sick Leave:**
```
curl -X POST http://localhost:3000/api/leaves/types \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"name":"Sick Leave","annual_quota":8}'
```

**Create Earned Leave:**
```
curl -X POST http://localhost:3000/api/leaves/types \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"name":"Earned Leave","annual_quota":12}'
```

Expected: HTTP 201 with created leave type `{ "id", "org_id", "name", "annual_quota" }`.

**Field Details:**
- `name`: Required string (1-100 characters). Must be unique within the organization.
- `annual_quota`: Required integer (0-365). Number of days allowed per year for this leave type.

**Edge Cases:**
- Duplicate `name` within the same organization → HTTP 409
- Missing required fields → HTTP 400
- Invalid `annual_quota` (negative or > 365) → HTTP 400
- Unauthorized (not admin/hr) → HTTP 403

**Update Leave Type:**
```
curl -X PUT http://localhost:3000/api/leaves/types/<leave_type_id> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"annual_quota":15}'
```

Expected: HTTP 200 with updated leave type.

**Delete Leave Type:**
```
curl -X DELETE http://localhost:3000/api/leaves/types/<leave_type_id> \
  -H "Authorization: Bearer <TOKEN_B>"
```

Expected: HTTP 204 (No Content).

**Note:** Cannot delete a leave type if there are existing leave requests using it → HTTP 409.

### 35a.1: List Leave Types (All Roles)

Use `<TOKEN_C>` (employee) or `<TOKEN_B>` (admin/hr/manager). Lists all leave types created for the org.

```
curl -X GET http://localhost:3000/api/leaves/types \
  -H "Authorization: Bearer <TOKEN_C>"
```

Expected: HTTP 200, `{ "items": [ { "id","org_id","name","annual_quota" }, ... ] }`.

### 35a.2: Employee Leave Summary (Apply Leave Counters)

This backs the “Apply Leaves” counters (e.g., `04 Casual`, `02 Sick`, `12 Earned`) on mobile.

```
curl -X GET "http://localhost:3000/api/leaves/my/summary?year=2025" \
  -H "Authorization: Bearer <TOKEN_C>"
```

Expected: HTTP 200 with:
- `year`
- `items[]`: `{ id, name, annual_quota, approved_days, pending_days, rejected_days, remaining_days }`

### 35a.3: Apply Leave (Employee)

This powers the **Apply Leaves** form (type, start/end date, reason, optional attachment).

Optional: Upload via `/api/uploads/upload` (Step 14) and use the returned `file_url` as `attachment_url` here.

```
curl -X POST http://localhost:3000/api/leaves/requests \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{
    "leave_type_id":"<leave_type_id_from_35a1>",
    "start_date":"2025-08-12",
    "end_date":"2025-08-13",
    "reason":"Family emergency",
    "attachment_url":"https://example.com/proof.pdf"
  }'
```

Expected: HTTP 201 with the created leave request:
- `id`, `org_id`, `user_id`, `leave_type_id`, `start_date`, `end_date`, `total_days`, `status:"PENDING"`, `reason`, `attachment_url`.

**`total_days` semantics (all leave endpoints):** Count of **scheduled working days** in the leave range for the employee’s department (`departments.working_days`, e.g. Mon–Fri), excluding organization holidays that are enabled for that user (per-user holiday overrides). Weekends and holidays inside the range are not counted. Example: Fri–Mon leave with a Mon–Fri schedule → `total_days` = **2**. If `working_days` is unset, Mon–Fri is assumed. Managers without a direct department use the primary managed department’s schedule.

**Response shape:** `total_days` is returned at the **top level** and inside `record.total_days` (where a `record` object exists) on list/detail/combined-request APIs: `GET /api/leaves/requests`, `GET /api/leaves/my`, `GET /api/leaves/requests/:id`, user leave lists, WFH list/detail APIs, and combined attendance+leave feeds. Apply/update responses include `total_days` on the root object. Values are recomputed on read; apply/update persist the working-day count to the database.

Edge cases:
- Overlaps existing `PENDING`/`APPROVED` leave for the same user → HTTP 409
- Requested days exceed yearly quota for that type → HTTP 400 (with quota details)

### 35a.3a: Get Leave Request by ID

View details of a specific leave request. Employees can view their own requests; admin/hr/manager can view any request in their org.

```
curl -X GET http://localhost:3000/api/leaves/requests/<leave_request_id> \
  -H "Authorization: Bearer <TOKEN_C>"
```

Expected: HTTP 200 with full leave request details including:
- `id`, `org_id`, `user` (employee info), `leave_type`, `start_date`, `end_date`, `total_days`
- `status`, `reason`, `attachment_url`, `approver_comment`
- `manager` (if approved), `applied_at`, `updated_at`

Edge cases:
- Request not found → HTTP 404
- Employee trying to view another employee's request → HTTP 403
- Request from different org → HTTP 403

### 35a.3b: Update Leave Request (Employee)

Update a pending leave request (change dates, reason, attachment, or leave type). Only the request owner can update, and only if status is `PENDING`.

```
curl -X PUT http://localhost:3000/api/leaves/requests/<leave_request_id> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{
    "start_date":"2025-08-14",
    "end_date":"2025-08-15",
    "reason":"Updated reason",
    "attachment_url":"https://example.com/new-proof.pdf"
  }'
```

**Field Details:**
- All fields are optional: `leave_type_id`, `start_date`, `end_date`, `reason`, `attachment_url`
- If dates are updated, overlap and quota checks are re-validated
- If `attachment_url` is set to `null`, it removes the attachment

Expected: HTTP 200 with updated leave request.

Edge cases:
- Request not found → HTTP 404
- Not the request owner → HTTP 403
- Request already approved/rejected → HTTP 400 ("Only pending leave requests can be updated")
- Updated dates overlap with another request → HTTP 409
- Updated dates exceed quota → HTTP 400

### 35a.3c: Cancel Leave Request (Employee or Admin/HR/Manager)

Cancel a pending or approved leave request. Allowed for: the request **owner**; **admin/HR** (any request in the org); or a **manager** of the employee’s department (request owner must be `employee` in a managed department). Only `PENDING` or `APPROVED` requests can be cancelled.

Preferred (same status shape as approve/reject):

```
curl -X PATCH http://localhost:3000/api/leaves/requests/<leave_request_id>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"status":"CANCELLED","comment":"Plans changed"}'
```

Optional `comment` is stored in `approver_comment` on the cancelled record. Employees may use this PATCH; approve/reject still require admin/hr/manager.

Legacy equivalent:

```
curl -X POST http://localhost:3000/api/leaves/requests/<leave_request_id>/cancel \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"comment":"Plans changed"}'
```

Expected: HTTP 200 with updated request (`status: CANCELLED`, `cancelled_at`, `cancelled_by`, and `approver_comment` when comment was provided). Record is retained for audit; linked helpdesk ticket is marked RESOLVED. When admin/HR/manager cancels someone else's leave, the employee receives a leave-cancelled push notification (if leave status notifications are enabled). Self-cancel does not send a push.

Edge cases:
- Request not found → HTTP 404
- Not the request owner, and not admin/hr, and not the employee’s department manager → HTTP 403
- Request already rejected/cancelled → HTTP 400 ("Only pending or approved leave requests can be cancelled")

### 35a.4: My Leaves List (Employee History Tabs)

This backs the **My Leaves** history screen with tabs `All`, `Pending`, `Approved`.

```
curl -X GET "http://localhost:3000/api/leaves/my?page=1&limit=10&status=PENDING" \
  -H "Authorization: Bearer <TOKEN_C>"
```

Query parameters:
- `page` (default 1)
- `limit` (default 10, max 100)
- `status` = `PENDING|APPROVED|REJECTED` (omit for all)
- `start_date`, `end_date` (optional, `YYYY-MM-DD`)

Expected: HTTP 200 with:
- `page`, `limit`, `total`, `total_pages`
- `data[]`: `{ id, leave_type, start_date, end_date, total_days, status, reason, attachment_url, applied_at }`

These map directly to the cards in the mobile “My Leaves” UI.

### 35a.5: Org Leave Activity & Approvals (Web Dashboard + Manager Mobile)

#### List Org Leave Requests

Use `<TOKEN_B>` (admin/hr/manager):

```
curl -X GET "http://localhost:3000/api/leaves/requests?page=1&limit=10&status=PENDING" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Optional query params:
- `status` = `PENDING|APPROVED|REJECTED`
- `leave_type_id` (UUID)
- `employee_id` (user UUID)
- `department_id` (UUID)
- `search` (matches employee name, employee_id, email, department, leave type)
- `start_date`, `end_date` (YYYY-MM-DD)

Expected: HTTP 200 with:
- `page`, `limit`, `total`, `total_pages`
- `data[]` items:
  - `employee` (id, employee_id, full_name, role, designation, department)
  - `leave_type` (id, name)
  - `start_date`, `end_date`, `total_days`, `status`
  - `reason`, `attachment_url`, `approver_comment`, `applied_at`
  - `overlaps_with_others` (boolean) and `overlap_count` (used for the “Warning: overlaps with 1 other teammate” pill).

#### Approve / Reject Leave Request

Use the same REST-ful status convention as attendance corrections.

**Approve:**
```
curl -X PATCH http://localhost:3000/api/leaves/requests/<leave_request_id>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"status":"APPROVED","comment":"Approved by manager"}'
```

**Reject:**
```
curl -X PATCH http://localhost:3000/api/leaves/requests/<leave_request_id>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"status":"REJECTED","comment":"Rejected by manager"}'
```

**Cancel** (owner, admin/hr, or department manager; see 35a.3c):
```
curl -X PATCH http://localhost:3000/api/leaves/requests/<leave_request_id>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"status":"CANCELLED"}'
```

Notes:
- `status` = `APPROVED`, `REJECTED`, or `CANCELLED` (case-insensitive).
- Approve/reject: only `PENDING` requests; admin/hr/manager only. Cancel: `PENDING` or `APPROVED`; owner, admin/hr, or manager of that employee’s department.
- Request must belong to the caller’s org; otherwise → HTTP 403.

Expected: HTTP 200 with the updated leave request (including new `status` and `approver_comment` for approve/reject).

### 35a.6: Leave Management Dashboard (Web)

This endpoint powers:
- Top cards (“Total on Leave (Today)”, break-up by leave type)
- Monthly calendar and “Leave Overview” chart
- “Employee Leaves (Today)” list
- “Leave Types” donut chart

```
curl -X GET "http://localhost:3000/api/leaves/dashboard?month=6&year=2035" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Optional:
- `focus_date=2035-06-12` (YYYY-MM-DD) — if omitted, defaults to today when it falls in the same month, otherwise first day of the month.

Expected: HTTP 200 with:
- `month`, `year`, `focus_date`
- `summary_today`:
  - `total_employees`
  - `total_on_leave`
  - `percentage_on_leave`
  - `by_type[]`: `{ id, name, count, percentage }` — count is number of employees on leave today for this type, percentage is % of total leave today
- `overview`:
  - `by_day[]`: `{ date, count }` — used for the monthly calendar heatmap (all days in the month)
  - `by_week[]`: `{ date, count }` — used for the "This Week" chart (Monday to Friday of the week containing focus_date)
  - `week_range`: `{ start_date, end_date }` — Monday and Friday dates for the current week
- `employee_leaves_on_focus_date[]`: Array of objects describing employees on leave for the `focus_date`, each containing:
  - `id`: Leave request ID
  - `start_date`, `end_date`, `status`
  - `leave_type`: `{ id, name }`
  - `employee`:
    - `id`
    - `employee_id`
    - `full_name`
    - `role`
    - `designation`
    - `department`: `{ id, name } | null`
- `types_breakdown[]`: `{ id, name, total_days, employee_count, percentage }` — backing the leave types donut chart:
  - `total_days`: Total leave days for this type in the month
  - `employee_count`: Number of unique employees who took this leave type (for donut chart center)
  - `percentage`: Percentage of total leave today (for donut chart segments)
- `public_holidays[]`: Array of date strings (YYYY-MM-DD) that are public holidays in the month (currently empty, can be extended with a public_holidays table)

**Sample Response:**
```json
{
  "month": 6,
  "year": 2035,
  "focus_date": "2035-06-19",
  "summary_today": {
    "total_employees": 128,
    "total_on_leave": 6,
    "percentage_on_leave": 4.69,
    "by_type": [
      {
        "id": "uuid-1",
        "name": "Annual Leave",
        "count": 3,
        "percentage": 50.0
      },
      {
        "id": "uuid-2",
        "name": "Sick Leave",
        "count": 2,
        "percentage": 33.33
      },
      {
        "id": "uuid-3",
        "name": "Other Leave",
        "count": 1,
        "percentage": 16.67
      }
    ]
  },
  "overview": {
    "by_day": [
      { "date": "2035-06-01", "count": 2 },
      { "date": "2035-06-02", "count": 3 },
      { "date": "2035-06-17", "count": 3 },
      { "date": "2035-06-18", "count": 3 },
      { "date": "2035-06-19", "count": 6 },
      { "date": "2035-06-20", "count": 6 },
      { "date": "2035-06-21", "count": 6 },
      { "date": "2035-06-22", "count": 6 }
    ],
    "by_week": [
      { "date": "2035-06-17", "count": 3 },
      { "date": "2035-06-18", "count": 3 },
      { "date": "2035-06-19", "count": 6 },
      { "date": "2035-06-20", "count": 6 },
      { "date": "2035-06-21", "count": 6 }
    ],
    "week_range": {
      "start_date": "2035-06-17",
      "end_date": "2035-06-21"
    }
  },
  "employee_leaves_on_focus_date": [
    {
      "id": "leave-uuid-1",
      "start_date": "2035-06-20",
      "end_date": "2035-06-22",
      "status": "APPROVED",
      "leave_type": {
        "id": "uuid-2",
        "name": "Sick Leave"
      },
      "employee": {
        "id": "user-uuid-1",
        "employee_id": "EMP001",
        "full_name": "Lina Armand",
        "role": "employee",
        "designation": "Software Engineer",
        "department": {
          "id": "dept-uuid-1",
          "name": "Engineering"
        }
      }
    },
    {
      "id": "leave-uuid-2",
      "start_date": "2035-06-17",
      "end_date": "2035-06-21",
      "status": "APPROVED",
      "leave_type": {
        "id": "uuid-1",
        "name": "Annual Leave"
      },
      "employee": {
        "id": "user-uuid-2",
        "employee_id": "EMP002",
        "full_name": "Jacob Yuen",
        "role": "employee",
        "designation": "Product Manager",
        "department": {
          "id": "dept-uuid-2",
          "name": "Product"
        }
      }
    }
  ],
  "types_breakdown": [
    {
      "id": "uuid-1",
      "name": "Annual Leave",
      "total_days": 15,
      "employee_count": 3,
      "percentage": 50.0
    },
    {
      "id": "uuid-2",
      "name": "Sick Leave",
      "total_days": 8,
      "employee_count": 2,
      "percentage": 33.3
    },
    {
      "id": "uuid-3",
      "name": "Other Leave",
      "total_days": 3,
      "employee_count": 1,
      "percentage": 16.7
    },
    {
      "id": "uuid-4",
      "name": "Casual Leave",
      "total_days": 0,
      "employee_count": 0,
      "percentage": 0.0
    }
  ],
  "public_holidays": []
}
```

## Step 35b2: Work From Home (WFH) Requests

Employees apply for WFH over a date range. Admin/HR/manager approve like leave. On an approved WFH day, clock-in must be within a department office location **or** an active admin-managed `user_allowed_location` (geofence is always enforced; see Step 32).

### Apply WFH

Preferred: **multipart/form-data** (supports optional document):

```
curl -X POST http://localhost:3000/api/wfh/requests \
  -H "Authorization: Bearer <TOKEN_C>" \
  -F 'start_date=2025-09-10' \
  -F 'end_date=2025-09-11' \
  -F 'reason=Home network maintenance day' \
  -F 'wfh_doc=@/path/to/proof.pdf'
```

Form fields: `start_date`, `end_date` (YYYY-MM-DD), `reason`, optional file `wfh_doc`, optional text `attachment_url` (if you already uploaded via `/api/uploads/upload`). File upload wins over `attachment_url` when both are sent.

For a **single day**, set `start_date` and `end_date` to the same value (e.g. both `2025-09-10`). Same-day requests are always accepted (`total_days` at least 1), including weekends/holidays.

Expected: HTTP 201 with `id`, `status:"PENDING"`, `start_date`, `end_date`, `total_days`, `reason`, `attachment_url` (nullable).

Edge cases:
- Overlaps existing `PENDING`/`APPROVED` WFH → HTTP 409
- Overlaps **APPROVED** leave → HTTP 409
- Multi-day range with no working days → HTTP 400 (same-day is never rejected for this reason)

### List my WFH requests

```
curl -X GET "http://localhost:3000/api/wfh/my?page=1&limit=10&status=PENDING" \
  -H "Authorization: Bearer <TOKEN_C>"
```

### List org WFH requests (Admin/HR/Manager)

```
curl -X GET "http://localhost:3000/api/wfh/requests?page=1&limit=10&status=PENDING" \
  -H "Authorization: Bearer <TOKEN_B>"
```

### List employee WFH requests (Admin/HR/Manager)

```
curl -X GET "http://localhost:3000/api/users/<user_id>/wfh/requests?page=1&limit=10" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Optional query params: `status`, `from_date`+`to_date` (or `start_date`+`end_date`). Response shape matches the org WFH list, filtered to that employee.

### Approve / Reject

Use the same REST-ful status convention as leave.

**Approve:**

```
curl -X PATCH http://localhost:3000/api/wfh/requests/<wfh_request_id>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"status":"APPROVED","comment":"Approved by manager"}'
```

**Reject:**

```
curl -X PATCH http://localhost:3000/api/wfh/requests/<wfh_request_id>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"status":"REJECTED","comment":"Please come to office"}'
```

**Cancel** (owner, admin/hr, or department manager; `PENDING` or `APPROVED`):

```
curl -X PATCH http://localhost:3000/api/wfh/requests/<wfh_request_id>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"status":"CANCELLED","comment":"Plans changed"}'
```

- `status` = `APPROVED`, `REJECTED`, or `CANCELLED` (case-insensitive).
- Optional `comment` on cancel is stored in `approver_comment`.
- Approve/reject require admin/hr/manager; cancel allows owner, admin/hr, or manager of that employee’s department.

Expected: HTTP 200 with the updated WFH request (including new `status` and `approver_comment` for approve/reject/cancel). Manager approval finalizes overall status immediately (same as leave). Cannot approve own request.

### Update / Cancel

Update a pending request via **multipart/form-data** (optional new doc):

```
curl -X PUT http://localhost:3000/api/wfh/requests/<wfh_request_id> \
  -H "Authorization: Bearer <TOKEN_C>" \
  -F 'start_date=2025-09-12' \
  -F 'end_date=2025-09-12' \
  -F 'reason=Updated' \
  -F 'wfh_doc=@/path/to/new-proof.pdf'
```

Uploading `wfh_doc` replaces the previous attachment. To remove an attachment without a new file, send text field `attachment_url` as empty/null (client-dependent); omit both to leave the existing attachment unchanged.

Legacy cancel (same rules as PATCH `CANCELLED`):

```
curl -X POST http://localhost:3000/api/wfh/requests/<wfh_request_id>/cancel \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"comment":"Plans changed"}'
```

Only `PENDING` requests can be updated. `PENDING` or `APPROVED` can be cancelled.

### Attendance impact

- Calendar/admin status: on-time punch on approved WFH day → `WFH` with `is_wfh: true`; late punch → `LATE` with `is_wfh: true`; no punch → `ABSENT`.
- Approved leave still takes precedence over WFH for the same day.

## Step 35c: Reimbursement Requests

Reimbursement requests are **separate from payroll and payslips**. Employees submit expenses for a specific day; admin/hr/manager approve or reject.

### 35c.1: Apply Reimbursement (Employee)

Preferred: **multipart/form-data** (supports optional receipt/document):

```
curl -X POST "http://localhost:3000/api/reimbursements/requests" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -F 'request_date=2035-06-15' \
  -F 'type=TRAVEL' \
  -F 'amount=1250.50' \
  -F 'reason=Client visit travel' \
  -F 'reimbursement_doc=@/path/to/receipt.pdf'
```

Form fields: `request_date` (YYYY-MM-DD), `type` (required: `TRAVEL` | `MEAL` | `MEDICAL` | `OTHER`), `amount`, `reason`, optional file `reimbursement_doc`.

JSON body (no file upload):

```
curl -X POST "http://localhost:3000/api/reimbursements/requests" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -H "Content-Type: application/json" \
  -d '{
    "request_date": "2035-06-15",
    "type": "TRAVEL",
    "amount": 1250.50,
    "reason": "Client visit travel"
  }'
```

Expected: HTTP 201 with `"type": "TRAVEL"`. Missing `type` returns HTTP 400. Multiple **PENDING** requests for the same `request_date` are allowed (e.g. TRAVEL and MEAL on the same day).

### 35c.1b: Update Reimbursement (Employee, PENDING only)

Replace fields or attachment via multipart:

```
curl -X PUT "http://localhost:3000/api/reimbursements/requests/<reimbursement_request_id>" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -F 'type=MEAL' \
  -F 'reason=Updated reason' \
  -F 'reimbursement_doc=@/path/to/new-receipt.pdf'
```

Optional fields: `type`, `request_date`, `amount`, `reason`, `reimbursement_doc`.

### 35c.1c: Cancel Reimbursement (Employee / Admin / HR / Manager)

Cancel a pending or approved reimbursement request. Allowed for: the request **owner**; **admin/HR** (any request in the org); or a **manager** of the employee’s department. Only `PENDING` or `APPROVED` requests can be cancelled.

Preferred (same status shape as approve/reject):

```
curl -X PATCH "http://localhost:3000/api/reimbursements/requests/<reimbursement_request_id>/status" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"status":"CANCELLED","comment":"Plans changed"}'
```

Optional `comment` is stored in `approver_comment`. Legacy equivalent:

```
curl -X POST "http://localhost:3000/api/reimbursements/requests/<reimbursement_request_id>/cancel" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"comment":"Plans changed"}'
```

Expected: HTTP 200 with updated request (`status: CANCELLED`, `cancelled_at`, `cancelled_by`, and `approver_comment` when comment was provided). Record is retained for audit. Payment fields are cleared on cancel.

Edge cases:
- Request not found → HTTP 404
- Not the request owner, and not admin/hr, and not the employee’s department manager → HTTP 403
- Request already rejected/cancelled → HTTP 400 ("Only pending or approved reimbursement requests can be cancelled")

### 35c.2: My Reimbursements (Employee)

```
curl -X GET "http://localhost:3000/api/reimbursements/my?page=1&limit=10" \
  -H "Authorization: Bearer <TOKEN_C>"
```

### 35c.2a: Employee Reimbursement List (Admin/HR/Manager)

List reimbursement requests for one employee (e.g. employee profile / activity panel):

```
curl -X GET "http://localhost:3000/api/users/<user_id>/reimbursements/requests?page=1&limit=10" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Optional query: `status`, `from_date` + `to_date` (filters `request_date` inclusively), `search`.

Expected: HTTP 200 with `{ page, limit, total, total_pages, items[] }` where each item has `request_type: "REIMBURSEMENT"` and belongs only to that user.

### 35c.3: Org Reimbursement List (Admin/HR/Manager)

```
curl -X GET "http://localhost:3000/api/reimbursements/requests?page=1&limit=10&status=PENDING" \
  -H "Authorization: Bearer <TOKEN_B>"
```

### 35c.3a: Get Reimbursement Request by ID

```
curl -X GET "http://localhost:3000/api/reimbursements/requests/<reimbursement_request_id>" \
  -H "Authorization: Bearer <TOKEN_C>"
```

Employees may only fetch their own request. Admin/hr/manager may fetch any request in the org.

Expected: HTTP 200 with paginated envelope (`page`, `limit`, `total`, `items[]`) containing one reimbursement item (`request_type: "REIMBURSEMENT"`).

### 35c.4: Approve / Reject / Cancel

```
curl -X PATCH "http://localhost:3000/api/reimbursements/requests/<reimbursement_request_id>/status" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -H "Content-Type: application/json" \
  -d '{"status":"APPROVED","comment":"Approved for client visit"}'
```

Use `"status":"REJECTED"` to reject (admin/hr/manager). Use `"status":"CANCELLED"` to cancel (owner, admin/hr, or department manager; `PENDING` or `APPROVED`; see 35c.1c). Managers cannot approve their own requests (HTTP 403).

### 35c.4b: Mark employee expense month as paid (Admin/HR/Manager)

Marks all **APPROVED** reimbursement requests for one employee whose `request_date` falls in the given calendar month:

```
curl -X POST "http://localhost:3000/api/users/<user_id>/reimbursements/mark-month-paid" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -H "Content-Type: application/json" \
  -d '{"year": 2026, "month": 5}'
```

Response: `{ year, month, user_id, updated_count, approved_total, paid_total }`.

List/detail items include `payment_status` (`UNPAID` | `PAID` for approved rows), `paid_at`, `paid_by_user_id`. New approvals start as `UNPAID`.

Notifications:
- When requests are updated to `payment_status = PAID`, the employee receives a push notification **per request** (best-effort).
- Controlled by org notification setting: `enabled_reimbursement_paid_notifications` (default `true`).

### 35c.5: Combined Requests Feed (Attendance + Leave only)

Combined endpoints return **ATTENDANCE** and **LEAVE** requests only. Reimbursements are **not** included; use org/user reimbursement list APIs (35c.2–35c.3) instead. WFH is listed via `/api/wfh/*` and `GET /api/users/:userId/wfh/requests`.

Optional query params (all three endpoints):
- `page`, `limit`
- `status` = `PENDING|APPROVED|REJECTED|CANCELLED` (omit for all; case-insensitive). Filters both attendance and leave by overall request status.
- `from_date` + `to_date` (or `start_date` + `end_date`): date range as before

```
curl -X GET "http://localhost:3000/api/requests/combined?page=1&limit=10&status=APPROVED" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Employee-scoped combined (admin/hr/manager):

```
curl -X GET "http://localhost:3000/api/users/<user_id>/requests/combined?page=1&limit=10&status=APPROVED" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Current user (JWT):

```
curl -X GET "http://localhost:3000/api/users/requests/combined/my?page=1&limit=10&status=APPROVED" \
  -H "Authorization: Bearer <TOKEN_C>"
```

## Step 36: Attendance - Calendar View (Employee)
Get attendance calendar for a month or date range. This endpoint provides a comprehensive view of attendance with late arrival detection, overtime calculation, and shift information.

**Option 1: Month/Year format**
```
curl -X GET "http://localhost:3000/api/attendance/calendar?month=1&year=2024" \
  -H "Authorization: Bearer <TOKEN_C>"
```

**Option 2: Date range format**
```
curl -X GET "http://localhost:3000/api/attendance/calendar?start_date=2024-01-01&end_date=2024-01-31" \
  -H "Authorization: Bearer <TOKEN_C>"
```

**Expected Response:** HTTP 200, JSON with:
- `start_date`: Start date of the range (YYYY-MM-DD)
- `end_date`: End date of the range (YYYY-MM-DD)
- `calendar`: Array of calendar entries, each containing:
  - `date`: Date string (YYYY-MM-DD)
  - `status`: One of `PRESENT`, `LATE`, `ABSENT`, `HALF_DAY`, `LEAVE`, `HOLIDAY`, `NOT_JOINED`
  - `clock_in_time`: ISO timestamp string (e.g., "2026-02-09T22:49:00.000Z") or null
  - `clock_out_time`: ISO timestamp string (e.g., "2026-02-09T22:49:00.000Z") or null
  - `total_work_seconds`: Total work seconds (number) or null
  - `total_break_seconds`: Total break seconds (number)
  - `is_excess_break`: Boolean indicating if break limit exceeded
  - `is_late_arrival`: Boolean indicating if user arrived late
  - `late_by_minutes`: Minutes late (number, 0 if on time)
  - `overtime_seconds`: Overtime seconds (number)
  - `effective_seconds`: Effective work seconds (number)
  - `shift_start_time`: ISO timestamp string for shift start time (e.g., "2026-02-09T09:00:00.000Z") or null
  - `shift_end_time`: ISO timestamp string for shift end time (e.g., "2026-02-09T18:00:00.000Z") or null

**Notes:**
- Use `month` (1-12) and `year` (2000-2100) for month view, OR `start_date` and `end_date` (YYYY-MM-DD) for custom range
- Both parameters are required for each option (cannot mix formats)
- Invalid dates or missing params return HTTP 400
- Status priority: ON_LEAVE > HOLIDAY > PRESENT/LATE > ABSENT
- Excess break is indicated by `is_excess_break: true`; it does not change the attendance status
- Days before the employee's `date_of_joining` are returned with status `NOT_JOINED` and are excluded from aggregate attendance calculations (they are not counted as ABSENT).
- Late arrival is calculated by comparing clock-in time with shift start time
- Overtime is calculated by comparing total work hours with shift duration
- All dates are normalized to ensure consistent timezone handling

## Step 36a: Attendance - Weekly Summary (Employee)
Get weekly attendance summary with aggregations and detailed daily logs. This endpoint provides comprehensive weekly statistics including total hours, average login time, late days, and overtime calculations.

```
curl -X GET "http://localhost:3000/api/attendance/weekly-summary?start_date=2024-01-01&end_date=2024-01-07" \
  -H "Authorization: Bearer <TOKEN_C>"
```

**Expected Response:** HTTP 200, JSON with:
- `start_date`: Start date of the range (YYYY-MM-DD)
- `end_date`: End date of the range (YYYY-MM-DD)
- `summary`: Aggregated statistics:
  - `total_days`: Total number of **join-adjusted** days in the range (excludes days before the employee's `date_of_joining`, which are marked as `NOT_JOINED`)
  - `total_hours`: Formatted string (e.g., "40h 30m")
  - `total_hours_decimal`: Total hours as decimal (e.g., 40.5)
  - `average_login_time`: Average clock-in time (HH:MM format)
  - `late_days`: Count of days with late arrival
  - `extra_time`: Formatted overtime string (e.g., "5h 30m")
  - `extra_time_minutes`: Total overtime in minutes
- `daily_logs`: Array of daily attendance entries, each containing:
  - `date`: Date string (YYYY-MM-DD)
  - `status`: One of `PRESENT`, `LATE_ARRIVAL`, `ON_TIME`, `ABSENT`, `HALF_DAY`, `NOT_JOINED`
  - `login_time`: Clock-in time as ISO timestamp string (e.g., "2026-02-09T22:49:00.000Z") or null
  - `logout_time`: Clock-out time as ISO timestamp string (e.g., "2026-02-09T22:49:00.000Z") or null
  - `total_break_seconds`: Total break seconds (number)
  - `effective_seconds`: Effective work seconds (number)
  - `overtime_seconds`: Overtime seconds (number)
  - `is_late_arrival`: Boolean indicating late arrival
  - `late_by_minutes`: Minutes late (number, 0 if on time)

**Notes:**
- Both `start_date` and `end_date` are required (YYYY-MM-DD format)
- Date range can span any number of days (not limited to 7 days)
- Includes all days in the range, even if no attendance record exists (marked as ABSENT), except days before the employee's `date_of_joining`, which are marked as `NOT_JOINED` and excluded from aggregate calculations.
- Late arrivals are calculated by comparing clock-in time with shift start time
- Overtime is calculated by comparing work hours with shift duration (supports night shifts)
- Average login time is calculated only from days with clock-in records

## Step 36b: Attendance - Monthly Performance (Employee)
Get monthly attendance performance metrics with score, detailed statistics, and pay impact alerts. This endpoint provides a comprehensive monthly view with performance scoring and actionable alerts.

```
curl -X GET "http://localhost:3000/api/attendance/monthly-performance?month=1&year=2024" \
  -H "Authorization: Bearer <TOKEN_C>"
```

**Expected Response:** HTTP 200, JSON with:
- `month`: Month number (1-12)
- `year`: Year number (2000-2100)
- `performance`: Performance metrics:
  - `total_score`: Attendance score as percentage (0-100)
  - `present_days`: Count of full present days
  - `leave_days`: Count of leave days (currently 0, reserved for future use)
  - `absent_days`: Count of absent days
  - `holiday_days`: Count of holiday days (currently 0, reserved for future use)
  - `half_day_count`: Count of half-day attendance
  - `late_arrival_count`: Count of days with late arrival
- `calendar`: Enhanced calendar entries with late arrival and overtime information (same format as Step 36 Calendar API)
- `pay_impact_alerts`: Array of alerts with:
  - `type`: Alert type (e.g., "LATE_MARKS")
  - `message`: Human-readable alert message
  - `late_count`: Number of late arrivals (if applicable)
  - `threshold`: Threshold value that triggered the alert (if applicable)

**Notes:**
- Both `month` (1-12) and `year` (2000-2100) are required
- Total score is calculated as: `(present_days / total_working_days) × 100`
- Total working days = present_days + absent_days + half_day_count + holiday_days
- Pay impact alerts are generated when:
  - Late marks ≥ 2: Warning alert
  - Late marks ≥ 5: Critical alert
- Calendar entries include all days of the month with status and detailed metrics
- Status priority: ON_LEAVE > HOLIDAY > PRESENT/LATE > ABSENT
- Excess break is indicated by `is_excess_break: true`; it does not change the attendance status

## Step 36c: Attendance - Admin Employee Attendance Table (Org-Level)

This endpoint powers the **Employee Attendance** admin table (second screenshot).

```
curl -X GET "http://localhost:3000/api/attendance/admin/users?page=1&limit=10&status=ALL&sort_by=NAME&sort_dir=ASC" \
  -H "Authorization: Bearer <TOKEN_B>"
```

Query parameters:
- `date` (optional): If provided, table shows attendance snapshot for that date (e.g. `2035-06-19`). If omitted, table shows each employee's **latest** attendance record.
- `page` (optional): Page number (default `1`, min `1`)
- `limit` (optional): Page size (default `10`, max `100`)
- `department_id` (optional): Filter by department UUID
- `work_model` (optional): `ONSITE|HYBRID|REMOTE` (from employment details)
- `status` (optional): `ON_TIME|LATE|LEAVE|HALF_DAY|ABSENT|WFH|ALL` (default: `ALL`)
- `leave_session` (optional): `FIRST_HALF|SECOND_HALF|ANY_HALF` — filter by approved half-day leave session. `ANY_HALF` returns all half-day leave rows regardless of punch status (includes `ON_TIME`/`LATE` rows with `is_on_halfday_leave=true`).
- `search` (optional): Case-insensitive search across `employee_id`, name, email, and department
- `sort_by` (optional): `NAME|STATUS|DATE` (default: `NAME`)
- `sort_dir` (optional): `ASC|DESC` (default: `ASC`)

Expected: HTTP 200 with:
- `page`, `limit`, `total`, `total_pages`, `date` (the requested date, or `null` when showing latest records)
- `data[]`: Each row represents one employee for either the requested date or their latest attendance record:
  - `employee`:
    - `id`
    - `employee_id`
    - `full_name`
    - `role`
    - `designation` (Job Title)
    - `department`: `{ id, name } | null`
    - `work_model`: `ONSITE|HYBRID|REMOTE|null`
  - `date`: Same as query date when `date` is provided; otherwise, the date of the employee's latest attendance log (or `null` if no log exists).
  - `clock_in_time`: Formatted `HH:MM` or `null`
  - `clock_out_time`: Formatted `HH:MM` or `null`
  - `duration_minutes`: Total work minutes for the day (if known) or `null`
  - `duration_formatted`: Human-readable duration such as `"8h 10m"` or `null`
  - `overtime_hours`: Decimal hours of overtime (>= 0)
  - `overtime_minutes`: Overtime in minutes
  - `status`: One of:
    - `ON_TIME`: Has attendance log and arrived on/before shift start (using user’s shift or department default shift)
    - `LATE`: Has attendance log and arrived after shift start
    - `LEAVE`: Has full-day approved leave covering `date`
    - `HALF_DAY`: Has approved half-day leave covering `date`, has **not** clocked in, and `date` is **today** (IST). Past dates with no punch show as `ABSENT`.
    - `ABSENT`: No attendance and no leave for `date`
  - `leave_session`: `FULL|FIRST_HALF|SECOND_HALF|null` — when `FIRST_HALF` or `SECOND_HALF`, the employee has approved half-day leave for that date
  - `session_window`: Shift window for the leave session (when half-day leave applies)
  - `is_on_halfday_leave`: `true` when `leave_session` is `FIRST_HALF` or `SECOND_HALF` — use for a badge even when `status` is `ON_TIME` or `LATE`
  - `late_by_minutes`: Minutes late (0 when `status` is not `LATE`)

Notes:
- Only attendance-scoped org roles (`employee`, `hr`, `manager`) with `status` in (`ACTIVE`, `ON_NOTICE`) and non-deleted users are included; `INACTIVE` users are excluded.
- Shift start/end are resolved from the user’s own shift first, then the department’s default shift.
- Duration and overtime rely on `attendance_logs.total_work_hours` when available; in-progress days without a stored total will return `duration_* = null`.

## Step 37: Attendance - Correction Request (Employee)
```
curl -X POST http://localhost:3000/api/attendance/requests \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"request_date":"2026-01-30","requested_clock_in":"2026-01-30T09:30:00Z","requested_clock_out":"2026-01-30T18:00:00Z","reason":"Missed punch"}'
```
Expected: HTTP 201, returns request `id`.

## Step 37a: Attendance - Regularize Attendance (Employee) (UI Flow)
This is the **Regularize Attendance** flow used by the mobile UI when the user needs to correct **one punch** (in/out) for a date, optionally with an attachment.

### 1) (Optional) Upload attachment
```
curl -X POST http://localhost:3000/api/uploads/upload \
  -H "Authorization: Bearer <TOKEN_C>" \
  -F "file=@regularize-proof.pdf" \
  -F "doc_category=EXPERIENCE" \
  -F "doc_type=ATTENDANCE_CORRECTION"
```
Expected: HTTP 200 with `files[0].file_url`. Use that URL as `attachment_url` below.

### 2) Submit regularization request
```
curl -X POST http://localhost:3000/api/attendance/requests/regularize \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{
    "request_date":"2024-01-15",
    "wrong_punch_type":"CLOCK_OUT",
    "corrected_time":"18:10",
    "reason":"Forgot to punch out",
    "attachment_url":"https://<your-bucket>/<path>/regularize-proof.pdf"
  }'
```
Expected: HTTP 201 with created request.

Notes:
- `wrong_punch_type` one of: `CLOCK_IN`, `CLOCK_OUT`, `BREAKS` (values are case-insensitive).
- `corrected_time` must be `HH:MM`.
- When there is an existing, **completed** attendance log for that date (with both clock-in and clock-out), this endpoint derives full `requested_clock_in` + `requested_clock_out` from that log (it corrects only one punch).
- For `CLOCK_IN` / `CLOCK_OUT` types, if there is **no attendance log at all** for that date (employee did not log in), the following rules apply:
  - You **can** submit a `CLOCK_IN`-side regularization (e.g. `wrong_punch_type = "CLOCK_IN"` with a `corrected_time`) using the same simple payload shape. On final approval, the system will create an `attendance_logs` row for that date with the corrected clock-in time so that the day appears in the employee's attendance view (clock-out can remain empty and will be treated as a half-day until corrected).
  - You **cannot** submit a `CLOCK_OUT`-only regularization for such a date (no prior clock-in exists to pair with it). In that case, use the full correction endpoint (`/api/attendance/requests`) with both `requested_clock_in` and `requested_clock_out` if you need to create a complete day from scratch.
- For `wrong_punch_type = "BREAKS"`, you can additionally send a `break_corrections[]` array to regularize multiple break start/end times for that date. See the next section.

### 3) Submit regularization request for multiple breaks (start/end times)
Use this when the employee had multiple breaks and one or more break punches were wrong (either start or end).

```
curl -X POST http://localhost:3000/api/attendance/requests/regularize \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{
    "request_date":"2024-01-15",
    "wrong_punch_type":"BREAKS",
    "corrected_time":"18:00",
    "reason":"Break punches were incorrect",
    "attachment_url":"https://<your-bucket>/<path>/regularize-proof.pdf",
    "break_corrections":[
      {
        "break_type":"LUNCH",
        "corrected_start_time":"13:05",
        "corrected_end_time":"13:35"
      },
      {
        "break_type":"TEA",
        "corrected_start_time":"16:10",
        "corrected_end_time":"16:20"
      }
    ]
  }'
```

Behavior:
- The request is still created as a regularization request and goes through the Manager → HR approval flow.
- On final **APPROVED**, the system:
  - Ensures there is an `attendance_logs` row for that date.
  - Rewrites the `attendance_breaks` rows for that log to match the `break_corrections` array (existing breaks for that day are deleted and reinserted with the corrected start/end times and `break_type` values).
- You can only create **one** `BREAKS`-type regularization per `request_date` per employee (but you can still create separate `CLOCK_IN` or `CLOCK_OUT` regularizations for the same date if needed).

## Step 37b: Attendance - List My Regularization/Correction Requests (Employee)
```
curl -X GET "http://localhost:3000/api/attendance/requests/my" \
  -H "Authorization: Bearer <TOKEN_C>"
```
Expected: HTTP 200 with `items[]` sorted by latest.

### 37b.0: Cancel Attendance Request (Employee / Admin / HR / Manager)

Cancel a pending or approved attendance correction/regularization request. Allowed for: the request **owner**; **admin/HR** (any request in the org); or a **manager** of the employee’s department. Only `PENDING` or `APPROVED` requests can be cancelled.

Preferred (same status shape as approve/reject):

```
curl -X PATCH http://localhost:3000/api/attendance/requests/<correction_request_id>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"status":"CANCELLED","comment":"Plans changed"}'
```

Optional `comment` is stored in `approver_comment`. Legacy equivalent:

```
curl -X POST http://localhost:3000/api/attendance/requests/<correction_request_id>/cancel \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"comment":"Plans changed"}'
```

Expected: HTTP 200 with updated request (`status: CANCELLED`, `cancelled_at`, `cancelled_by`, and `approver_comment` when comment was provided). Record is retained for audit; linked helpdesk ticket is marked RESOLVED.

Edge cases:
- Request not found → HTTP 404
- Not the request owner, and not admin/hr, and not the employee’s department manager → HTTP 403
- Request already rejected/cancelled → HTTP 400 ("Only pending or approved attendance requests can be cancelled")

### 37b.1: Attendance - Regularization Details (Employee, Helper API)

Before calling the regularization endpoint, the UI can use this helper to fetch existing punches and breaks for a date and decide which `wrong_punch_type` options to show.

```
curl -X GET "http://localhost:3000/api/attendance/requests/regularize/details?request_date=2024-01-15" \
  -H "Authorization: Bearer <TOKEN_C>"
```

Expected: HTTP 200 with:

```json
{
  "request_date": "2024-01-15",
  "has_clock_in": true,
  "has_clock_out": true,
  "clock_in_time": "2024-01-15T09:10:00.000Z",
  "clock_out_time": "2024-01-15T18:05:00.000Z",
  "breaks": [
    {
      "id": 123,
      "break_type": "LUNCH",
      "start_time": "2024-01-15T13:00:00.000Z",
      "end_time": "2024-01-15T13:30:00.000Z"
    }
  ]
}
```

If no attendance log exists for that date, the API returns HTTP 404.

## Step 38: Attendance - Approve/Reject/Cancel Correction
Use the REST-ful status endpoint to approve, reject, or cancel a correction request.

### Approve
```
curl -X PATCH http://localhost:3000/api/attendance/requests/<request_id_from_step_37>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{"status":"APPROVED","comment":"Approved by admin"}'
```
Expected: HTTP 200, status `APPROVED`.

### Cancel (owner, admin/hr, or department manager; PENDING or APPROVED)
```
curl -X PATCH http://localhost:3000/api/attendance/requests/<request_id_from_step_37>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{"status":"CANCELLED"}'
```
Expected: HTTP 200, status `CANCELLED`. See 37b.0 for eligibility. Approve/reject still require admin/hr/manager.

## Step 38a: Attendance - List Requests (Manager/HR/Admin)
```
curl -X GET "http://localhost:3000/api/attendance/requests?step=ANY&statuses=PENDING" \
  -H "Authorization: Bearer <TOKEN_B>"
```
Expected: HTTP 200 with `items[]`.

Notes:
- `statuses`: Optional, one or more overall request statuses to include. Allowed values: `PENDING`, `APPROVED`, `REJECTED`. You can repeat the param to include multiple, for example:
  - `?statuses=PENDING&statuses=APPROVED` → pending + approved requests.
  - When omitted, defaults to only `PENDING`.
- `step`: Filters who needs to act **for pending items**:
  - `step=MANAGER`: requests needing manager action (manager_status = PENDING).
  - `step=HR`: requests already manager-approved and waiting for HR (manager_status = APPROVED, hr_status = PENDING).
  - `step=ANY`: no additional step filter.
- Both `step` and `statuses` are case-insensitive; values like `"any"`, `"manager"`, `"hr"`, `"pending"`, `"approved"` are normalized internally.
- In the response, `manager_status` and `hr_status` fields are always returned as lowercase strings (`"pending"`, `"approved"`, `"rejected"`), even though they are stored in uppercase in the database.

## Step 38b: Attendance - Manager Approve/Reject (Staged Flow)
Managers act first. On **APPROVED**, the request is forwarded to HR (still overall `status: PENDING`).
```
curl -X PATCH http://localhost:3000/api/attendance/requests/<request_id>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_MANAGER>" \
  -d '{"status":"APPROVED","comment":"OK"}'
```
Expected: HTTP 200 with message like \"Manager approved. Request forwarded to HR for final approval.\"

## Step 38c: Attendance - HR Final Approve/Reject
HR approves after manager approval. On **APPROVE**, the attendance log is patched/inserted.
```
curl -X PATCH http://localhost:3000/api/attendance/requests/<request_id>/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_HR>" \
  -d '{"status":"APPROVED","comment":"Approved by HR"}'
```
Expected: HTTP 200 with status `APPROVED`.


## Edge Cases (Optional)
1) Admin login wrong password -> 401  
2) Login missing fields -> 400  
3) Login wrong password -> 401  
4) Reset password missing fields -> 400  
5) Reset password wrong current password -> 401  
6) Create department without token -> 401  
7) Create user invalid `departmentId` -> 400  
8) Create user duplicate `email` -> 409  
9) Create employee duplicate `email` via onboarding -> 409  
10) Employee trying to create department -> 403  
11) Onboarding start missing required profile fields or arrays -> 400  
12) Onboarding start empty arrays (emergency_contacts/addresses) -> 400  
13) Onboarding employment invalid `department_id` -> 400  
14) Onboarding employment invalid enum values -> 400  
15) Onboarding upload document missing fields -> 400  
16) Onboarding compliance missing `offer_letter_url` -> 400  
17) Onboarding compliance invalid `device_pref` enum -> 400  
18) Onboarding document invalid enum (doc_category) -> 400  
19) Self-onboarding without password reset -> 403  
20) Login with org_id provided -> 400  
22) Select org with invalid token -> 401/403  
23) Upload endpoint without token -> 401  
24) Upload endpoint missing file/files -> 400  
25) Upload endpoint missing doc_category/doc_type (single or per-file) -> 400  
26) Upload endpoint invalid enum (doc_category) -> 400  
27) Upload endpoint file size exceeding limit -> 400  
28) Upload endpoint S3 not configured -> 500
29) Attendance clock-in outside geofence -> 403  
30) Attendance clock-out before clock-in -> 400  
31) Attendance break start before clock-in -> 400  
32) Attendance break end without active break -> 400  
33) Attendance clock-out while on break -> 400  
34) Attendance break start invalid enum -> 400  
35) Attendance correction approve invalid requestId -> 400  
36) Office location create without token -> 401  
37) Office location create missing fields -> 400  
38) Office location create duplicate name -> 409  
39) Office location get non-existent -> 404  
40) Work shift create without token -> 401  
41) Work shift create missing fields -> 400  
42) Work shift create invalid time format -> 400  
43) Work shift create duplicate name -> 409  
44) Work shift get non-existent -> 404  
45) Department update without token -> 401  
46) Department update non-existent -> 404  
47) Department update invalid location_id -> 400  
48) Department update invalid default_shift_id -> 400  
49) Department update duplicate name -> 409
50) Payroll - Employee accessing admin endpoint -> 403
51) Payroll - Invalid PAN format -> 400
52) Payroll - Invalid Aadhaar format -> 400
53) Payroll - Invalid UAN format -> 400
54) Payroll - Negative declared tax -> 400
55) Payroll - Salary slip with invalid month -> 400
56) Payroll - Salary slip with invalid year -> 400
57) Payroll - Salary slip with no record -> 404
58) Payroll - Create component with duplicate code -> 409
59) Payroll - Create component with invalid code format -> 400
60) Payroll - Create structure with effective_to before effective_from -> 400
61) Payroll - Create structure with net_salary > gross_salary -> 400
62) Payroll - Create structure with invalid component IDs -> 400
63) Payroll - Create payroll record with duplicate (same user, month, year) -> 409
64) Payroll - Create payroll record with invalid month -> 400
65) Payroll - Create payroll record with invalid year -> 400
66) Payroll - Upload file with invalid type -> 400
67) Payroll - Upload file with invalid month/year -> 400

## Step 39: Payroll Module

The Payroll Module provides comprehensive payroll management with employee self-service and admin/HR management capabilities.

**Automatic monthly payroll records:** The server creates **pending** payroll rows for the **previous calendar month** (IST) from each employee’s active salary structure only on **IST calendar day 1** (midnight-aligned tick), with a **one-shot grace on IST day 1–2** after startup to recover from a brief outage. **No automatic creation** (scheduler, onboarding `generateCurrentMonthPayrollForUser`, or admin list/dashboard “ensure” healing) runs for the **IST in-progress** month or future months; use **admin manual create** for exceptions. Creation is idempotent. Payslips are still generated later when a record is processed or marked PAID.

**Dev: simulate past-month attendance (for payslip LOP / working-days testing):** From repo root, with `.env` DB credentials loaded (same as the app), run e.g. `npm run simulate:attendance -- --org=<uuid> --user=<uuid> --year=2026 --month=4 --mode=all-scheduled` or `--mode=dates --dates=2026-04-01,2026-04-02`. The script also **creates a missing payroll record** for that user/month (from effective salary structure) unless you pass `--no-payroll`. Add **`--use-latest-salary-structure`** when the user’s structure `effective_from` / `effective_to` does not cover the simulated month but you still want a row from their **latest active** structure (dev only). Use `--dry-run` to print dates and metrics without writing. Use `--cleanup` with the same org/user/year/month to remove simulated attendance rows only. Refuses `production` unless `ALLOW_SEED_SIMULATED_ATTENDANCE=true`.

### 39.0: Employee - Get Payroll Details

Employees can view and update their payroll-related information (PAN, Aadhaar, PF, UAN, ESI, tax details).

**Get My Payroll Details:**
```
curl -X GET http://localhost:3000/api/payroll/my/details \
  -H "Authorization: Bearer <TOKEN_C>"
```
Expected: HTTP 200 with payroll details. If no record exists, an empty record is automatically created.

**Update My Payroll Details:**
```
curl -X PUT http://localhost:3000/api/payroll/my/details \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_C>" \
  -d '{
    "pan_number":"ABCDE1234F",
    "aadhaar_number":"123412341234",
    "pf_number":"PF123456",
    "uan_number":"123456789012",
    "esi_number":"ESI123456",
    "tax_saving_investments":"Mutual Funds ₹50,000",
    "declared_tax":5000
  }'
```
Expected: HTTP 200 with updated payroll details.

**Field Details:**
- `pan_number`: Optional, must be exactly 10 characters in format `AAAAA1234A` (5 uppercase letters + 4 digits + 1 uppercase letter)
- `aadhaar_number`: Optional, must be exactly 12 numeric digits
- `pf_number`: Optional, 1-50 characters
- `uan_number`: Optional, must be exactly 12 numeric digits
- `esi_number`: Optional, 1-50 characters
- `tax_saving_investments`: Optional string
- `declared_tax`: Optional non-negative number

**Edge Cases:**
- Invalid PAN format → HTTP 400
- Invalid Aadhaar format (non-numeric or wrong length) → HTTP 400
- Invalid UAN format (non-numeric or wrong length) → HTTP 400
- Negative declared_tax → HTTP 400

### 39.1: Employee - Download Salary Slip

Employees can download their monthly salary slip as PDF. Supports two methods: by month/year or by payroll record ID.

**Download Salary Slip (by Month/Year):**
```
curl -X GET "http://localhost:3000/api/payroll/my/salary-slip?month=6&year=2024" \
  -H "Authorization: Bearer <TOKEN_C>"
```
Expected: HTTP 200 with PDF file. If month/year not provided, defaults to current month/year.

**Query Parameters:**
- `month`: Optional (1-12), defaults to current month
- `year`: Optional (2000-2100), defaults to current year

**Download Salary Slip (by Payroll Record ID):**
```
curl -X GET "http://localhost:3000/api/payroll/my/salary-slip/{{payrollRecordId}}" \
  -H "Authorization: Bearer <TOKEN_C>"
```
Expected: HTTP 200 with PDF file. Use this method when you have the payroll record ID from the My Pay dashboard or history.

**Path Parameters:**
- `id` (required): Payroll record UUID

**Edge Cases:**
- Invalid month (0, 13, or out of range) → HTTP 400
- Invalid year (< 2000 or > 2100) → HTTP 400
- No payroll record for the month → HTTP 404
- Unauthorized (trying to access another employee's payslip) → HTTP 404

### 39.2: Employee - Get My Pay Dashboard

Get employee "My Pay" dashboard data including summary cards (worked days, overtime days, unpaid days), current month payroll record with status and net pay, and payslip history (last 10 records). This is the main endpoint for the employee pay dashboard view.

**Get My Pay Dashboard:**
```
curl -X GET "http://localhost:3000/api/payroll/my-pay?month=10&year=2025" \
  -H "Authorization: Bearer <TOKEN_C>"
```

**Query Parameters:**
- `month` (optional): Month (1-12), defaults to current month
- `year` (optional): Year (2000-2100), defaults to current year

**Expected Response (HTTP 200):**
```json
{
  "selected_range": {
    "month": 10,
    "year": 2025,
    "month_name": "October",
    "start_date": "2025-10-01",
    "end_date": "2025-10-31"
  },
  "summary_cards": {
    "worked_days": {
      "worked": 22,
      "total": 24,
      "label": "Worked 22 / 24 Days"
    },
    "overtime_days": {
      "days": 2,
      "label": "Overtime 2 Days"
    },
    "unpaid_days": {
      "days": 0,
      "label": "Unpaid 0 Days"
    }
  },
  "current_month": {
    "id": "uuid",
    "month": 10,
    "year": 2025,
    "month_name": "October",
    "status": "PAID",
    "net_salary": 4250.00,
    "gross_salary": 5000.00,
    "total_earnings": 5500.00,
    "total_deductions": 1250.00,
    "date": "2025-10-01",
    "paid_at": "2025-10-31T00:00:00.000Z",
    "payslip_url": "https://s3.../payslip.pdf"
  },
  "payslip_history": [
    {
      "id": "uuid",
      "month": 9,
      "year": 2025,
      "month_name": "September",
      "status": "PAID",
      "net_salary": 4250.00,
      "date": "2025-09-01",
      "credited_date": "2025-10-01",
      "payslip_url": "https://s3.../payslip.pdf"
    }
  ]
}
```

**Field Details:**
- `selected_range`: Selected month/year range for the dashboard
- `summary_cards.worked_days`: Days with both clock in and clock out vs total working days in month
- `summary_cards.overtime_days`: Number of days with overtime (work hours > 8 hours)
- `summary_cards.unpaid_days`: Number of absent days (not on leave)
- `current_month`: Current month's payroll record (null if no record exists)
- `payslip_history`: Array of last 10 paid/adjusted/processed payroll records

### 39.3: Employee - Get My Pay History

Get paginated payslip history for the employee. Returns list of all paid/adjusted/processed payroll records.

**Get My Pay History:**
```
curl -X GET "http://localhost:3000/api/payroll/my-pay/history?page=1&limit=10" \
  -H "Authorization: Bearer <TOKEN_C>"
```

**Query Parameters:**
- `page` (optional): Page number (default 1, min 1, max 10000)
- `limit` (optional): Items per page (default 10, min 1, max 100)

**Expected Response (HTTP 200):**
```json
{
  "data": [
    {
      "id": "uuid",
      "month": 9,
      "year": 2025,
      "month_name": "September",
      "status": "PAID",
      "net_salary": 4250.00,
      "date": "2025-09-01",
      "credited_date": "2025-10-01",
      "payslip_url": "https://s3.../payslip.pdf"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25,
    "total_pages": 3
  }
}
```

**Field Details:**
- `data`: Array of payroll records sorted by year and month (descending)
- `pagination`: Pagination metadata

### 39.4: Employee - Monthly Salary Summary

Get detailed monthly salary summary.

**Get Monthly Summary:**
```
curl -X GET "http://localhost:3000/api/payroll/my/monthly-summary?month=6&year=2024" \
  -H "Authorization: Bearer <TOKEN_C>"
```
Expected: HTTP 200 with:
- `month`, `year`
- `gross_salary`, `total_earnings`, `total_deductions`, `net_salary`
- `pf_contribution`, `esi_contribution`, `income_tax`, `professional_tax`
- `overtime_amount`, `incentive_amount`, `bonus_amount`, `allowance_amount`
- `status`, `payslip_pdf_url`

### 39.3: Employee - Yearly Salary Summary

Get yearly salary summary with monthly breakdown and totals.

**Get Yearly Summary:**
```
curl -X GET "http://localhost:3000/api/payroll/my/yearly-summary?year=2024" \
  -H "Authorization: Bearer <TOKEN_C>"
```
Expected: HTTP 200 with:
- `year`
- `monthly_breakdown[]`: Array of monthly summaries
- `totals`: `total_gross`, `total_earnings`, `total_deductions`, `total_net`

### 39.4: Employee - Tax Summary

Get comprehensive tax summary for a year.

**Get Tax Summary:**
```
curl -X GET "http://localhost:3000/api/payroll/my/tax-summary?year=2024" \
  -H "Authorization: Bearer <TOKEN_C>"
```
Expected: HTTP 200 with:
- `year`
- `total_taxable_income`, `total_income_tax`, `total_professional_tax`, `total_tax`
- `declared_tax`, `tax_saving_investments`
- `monthly_breakdown[]`: Monthly tax breakdown

### 39.5: Admin/HR - Salary Components Management

Admin/HR can create and manage reusable salary components (Basic, HRA, DA, etc.).

**List Salary Components:**
```
curl -X GET http://localhost:3000/api/payroll/admin/components \
  -H "Authorization: Bearer <TOKEN_B>"
```
Expected: HTTP 200 with array of salary components.

**Create Salary Component:**
```
curl -X POST http://localhost:3000/api/payroll/admin/components \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "name":"Basic Salary",
    "code":"BASIC",
    "type":"EARNING",
    "is_taxable":true,
    "is_pf_applicable":true,
    "is_esi_applicable":false,
    "display_order":1
  }'
```
Expected: HTTP 201 with created component.

**Field Details:**
- `name`: Required string (1-100 characters)
- `code`: Required string (1-50 characters), must be uppercase alphanumeric with underscores only (e.g., `BASIC`, `HRA_123`)
- `type`: Required enum (`EARNING`, `DEDUCTION`, `ALLOWANCE`, `BONUS`, `OVERTIME`, `INCENTIVE`)
- `is_taxable`: Optional boolean (default: true)
- `is_pf_applicable`: Optional boolean (default: false)
- `is_esi_applicable`: Optional boolean (default: false)
- `display_order`: Optional integer (default: 0)

**Update Salary Component:**
```
curl -X PUT http://localhost:3000/api/payroll/admin/components/<component_id> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "name":"Updated Basic Salary",
    "is_taxable":false
  }'
```
Expected: HTTP 200 with updated component.

**Delete Salary Component (Soft Delete):**
```
curl -X DELETE http://localhost:3000/api/payroll/admin/components/<component_id> \
  -H "Authorization: Bearer <TOKEN_B>"
```
Expected: HTTP 200 with success message.

**Edge Cases:**
- Duplicate code within organization → HTTP 409
- Invalid code format (lowercase, special chars) → HTTP 400
- Invalid type enum → HTTP 400
- Employee accessing admin endpoint → HTTP 403

### 39.6: Admin/HR - Salary Structures

Admin/HR can create salary structures for employees with component breakdowns.

**List Salary Structures:**
```
curl -X GET "http://localhost:3000/api/payroll/admin/structures?userId=<user_id>" \
  -H "Authorization: Bearer <TOKEN_B>"
```
Expected: HTTP 200 with array of salary structures. `userId` query parameter is optional.

**Create Salary Structure:**
```
curl -X POST http://localhost:3000/api/payroll/admin/structures \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "user_id":"<user_id>",
    "effective_from":"2024-01-01",
    "effective_to":"2024-12-31",
    "gross_salary":50000,
    "net_salary":45000,
    "component_breakdown":{
      "<component_id_1>":30000,
      "<component_id_2>":10000,
      "<component_id_3>":10000
    },
    "notes":"New salary structure effective from January 2024"
  }'
```
Expected: HTTP 201 with created structure. Existing active structures for the user are automatically deactivated.

**Field Details:**
- `user_id`: Required UUID
- `effective_from`: Required date (YYYY-MM-DD format)
- `effective_to`: Optional date (YYYY-MM-DD format), must be >= effective_from
- `gross_salary`: Required positive number
- `net_salary`: Required positive number, must be <= gross_salary
- `component_breakdown`: Required object mapping component IDs to non-negative amounts
- `notes`: Optional string

**Update Salary Structure:**
```
curl -X PUT http://localhost:3000/api/payroll/admin/structures/<structure_id> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "net_salary":46000,
    "notes":"Updated salary structure"
  }'
```
Expected: HTTP 200 with updated structure.

**Edge Cases:**
- effective_to before effective_from → HTTP 400
- net_salary > gross_salary → HTTP 400
- Invalid component IDs → HTTP 400
- Components from different org → HTTP 400
- Non-existent user → HTTP 404
- User from different org → HTTP 404

### 39.7: Admin/HR - Payroll Records Management

Admin/HR can create, update, and manage monthly payroll records.

**List Payroll Records:**
```
curl -X GET "http://localhost:3000/api/payroll/admin/records?page=1&limit=10&month=6&year=2024&status=PAID" \
  -H "Authorization: Bearer <TOKEN_B>"
```
Expected: HTTP 200 with paginated payroll records.

**Query Parameters:**
- `page`: Optional (1-10000), default: 1
- `limit`: Optional (1-100), default: 10
- `month`: Optional (1-12)
- `year`: Optional (2000-2100)
- `user_id`: Optional UUID
- `status`: Optional enum (`DRAFT`, `PROCESSED`, `PAID`, `CANCELLED`)
- `search`: Optional string (searches employee name, ID, email)

**Create Payroll Record:**
```
curl -X POST http://localhost:3000/api/payroll/admin/records \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "user_id":"<user_id>",
    "payroll_month":6,
    "payroll_year":2024,
    "gross_salary":50000,
    "total_earnings":50000,
    "total_deductions":5000,
    "net_salary":45000,
    "pf_contribution":1800,
    "esi_contribution":375,
    "income_tax":2000,
    "professional_tax":200,
    "overtime_amount":5000,
    "incentive_amount":2000,
    "bonus_amount":0,
    "allowance_amount":3000,
    "component_breakdown":{
      "<component_id_1>":30000,
      "<component_id_2>":10000,
      "<component_id_3>":10000
    },
    "notes":"June 2024 payroll"
  }'
```
Expected: HTTP 201 with created record (status: DRAFT).

**Update Payroll Record:**
```
curl -X PUT http://localhost:3000/api/payroll/admin/records/<record_id> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "status":"PAID"
  }'
```
Expected: HTTP 200 with updated record.

**Request Body Fields:**
- All fields from `createPayrollRecordSchema` are optional
- `status`: Optional enum (PENDING, ADJUSTED, PAID, DRAFT, PROCESSED, CANCELLED)
- When status is set to PAID:
  - `paid_at` timestamp is automatically set
  - Payslip PDF is automatically generated and uploaded to S3 (if `payslip_pdf_url` is not already set)
  - The S3 URL is saved in `payslip_pdf_url` field
  - The payslip URL will be available in other payroll and payslip APIs
- When status is set to PROCESSED, `processed_at` timestamp is automatically set

**Note:** When marking a payroll record as PAID, the system automatically generates a payslip PDF in the standard format, uploads it to S3, and saves the URL. This URL is then available in all payroll listing APIs and payslip download endpoints.

**Process Payroll Record (Generate Payslip PDF):**
```
curl -X POST http://localhost:3000/api/payroll/admin/records/<record_id>/process \
  -H "Authorization: Bearer <TOKEN_B>"
```
Expected: HTTP 200 with updated record including `payslip_pdf_url` and status set to `PROCESSED`.

**Edge Cases:**
- Duplicate record (same user, month, year) → HTTP 409
- Invalid month/year → HTTP 400
- Negative salary values → HTTP 400
- Non-existent user → HTTP 404
- User from different org → HTTP 404

### 39.8: Admin/HR - Payroll File Upload

Admin/HR can upload Excel or PDF files for bulk payroll processing.

**Upload Payroll File:**
```
curl -X POST "http://localhost:3000/api/payroll/admin/upload?month=6&year=2024" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -F "file=@payroll-june-2024.xlsx"
```
Expected: HTTP 201 with upload record. File is processed asynchronously.

**Query Parameters:**
- `month`: Required (1-12)
- `year`: Required (2000-2100)

**File Requirements:**
- File type: Excel (.xlsx, .xls) or PDF
- Max size: 10MB
- Excel format: Should contain columns like `employee_id`, `gross_salary`, `net_salary`, etc.

**Edge Cases:**
- Invalid file type → HTTP 400
- File too large → HTTP 400
- Invalid month/year → HTTP 400
- Missing file → HTTP 400

**Note:** Excel files are processed asynchronously. Check upload status via the upload record. Processing errors are tracked in `processing_errors` field.

### 39.9: Admin/HR - Payroll Dashboard Summary

Get payroll dashboard summary cards showing totals for salary, allowances, overtime, and incentives with percentage changes from the previous month.

**Get Payroll Dashboard Summary:**
```
curl -X GET "http://localhost:3000/api/payroll/admin/dashboard/summary?month=6&year=2024" \
  -H "Authorization: Bearer <TOKEN_B>"
```

**Query Parameters:**
- `month` (optional, default: current month): Month number (1-12)
- `year` (optional, default: current year): Year (2000-2100)

**Expected Response (HTTP 200):**
```json
{
  "total_salary": {
    "value": 352000,
    "change_percentage": 5.4,
    "change_display": "+5.4%",
    "previous_month": "May"
  },
  "total_allowances": {
    "value": 15000,
    "change_percentage": 3.6,
    "change_display": "+3.6%",
    "previous_month": "May"
  },
  "total_overtime": {
    "value": 4800,
    "change_percentage": 2.3,
    "change_display": "+2.3%",
    "previous_month": "May"
  },
  "total_incentives": {
    "value": 6500,
    "change_percentage": 4.9,
    "change_display": "+4.9%",
    "previous_month": "May"
  }
}
```

**Field Details:**
- `total_salary.value`: Sum of `gross_salary` from all payroll records in the specified month with status `PROCESSED` or `PAID`
- `total_allowances.value`: Sum of `allowance_amount` from all payroll records in the specified month with status `PROCESSED` or `PAID`
- `total_overtime.value`: Sum of `overtime_amount` from all payroll records in the specified month with status `PROCESSED` or `PAID`
- `total_incentives.value`: Sum of `incentive_amount` from all payroll records in the specified month with status `PROCESSED` or `PAID`
- `change_percentage`: Percentage change from the previous month (positive or negative)
- `change_display`: Formatted percentage string with sign (e.g., "+5.4%" or "-2.1%")
- `previous_month`: Name of the previous month (e.g., "May", "June")

**Notes:**
- Only accessible to `admin` and `hr` roles.
- Only includes payroll records with status `PROCESSED` or `PAID`.
- If no records exist for the previous month, percentage change is calculated as 100% if current month has values, or 0% if both are zero.
- Values are returned as numbers (not formatted as currency) - frontend should format them as needed.

### 39.10: Admin/HR - Payroll List (Table View)

Get paginated list of payroll records formatted for the admin payroll list table view.

**Get Payroll List:**
```
curl -X GET "http://localhost:3000/api/payroll/admin/list?page=1&limit=10&month=6&year=2024&status=PAID&search=Olivia&sort_by=NAME&sort_dir=ASC" \
  -H "Authorization: Bearer <TOKEN_B>"
```

**Query Parameters:**
- `page` (optional, default: 1): Page number (1-10000)
- `limit` (optional, default: 10): Items per page (1-100)
- `month` (optional): Filter by payroll month (1-12)
- `year` (optional): Filter by payroll year (2000-2100)
- `user_id` (optional): Filter by user UUID
- `status` (optional): Filter by status (`DRAFT`, `PROCESSED`, `PAID`, `CANCELLED`)
- `search` (optional): Search across employee name, employee ID, and email
- `sort_by` (optional, default: `DATE`): Sort field (`NAME`, `JOB_TITLE`, `SALARY`, `TOTAL`, `STATUS`, `DATE`)
- `sort_dir` (optional, default: `DESC`): Sort direction (`ASC`, `DESC`)

**Expected Response (HTTP 200):**
```json
{
  "page": 1,
  "limit": 10,
  "total": 102,
  "total_pages": 11,
  "data": [
    {
      "id": "uuid",
      "name": {
        "full_name": "Olivia Mason",
        "employee_id": "EMP-0234"
      },
      "job_title": {
        "title": "Executive Marketing",
        "department": "Marketing"
      },
      "salary": 3200,
      "allowances": 300,
      "overtime": 60,
      "incentives": 150,
      "deductions": 120,
      "total": 3590,
      "status": "PAID",
      "date": "2024-06-01",
      "payslip_url": "https://example.com/payslip.pdf"
    },
    {
      "id": "uuid",
      "name": {
        "full_name": "Ethan Ray",
        "employee_id": "EMP-0178"
      },
      "job_title": {
        "title": "UI Designer",
        "department": "Product Design"
      },
      "salary": 3100,
      "allowances": 280,
      "overtime": 50,
      "incentives": 100,
      "deductions": 130,
      "total": 3400,
      "status": "PENDING",
      "date": "2024-06-01",
      "payslip_url": null
    }
  ]
}
```

**Field Details:**
- `name.full_name`: Employee's full name (first_name + last_name)
- `name.employee_id`: Employee ID (e.g., "EMP-0234")
- `job_title.title`: Employee's designation/job title
- `job_title.department`: Department name
- `salary`: Gross salary amount (from `gross_salary`)
- `allowances`: Allowance amount (from `allowance_amount`, can be `null`)
- `overtime`: Overtime amount (from `overtime_amount`, can be `null`)
- `incentives`: Incentive amount (from `incentive_amount`, can be `null`)
- `deductions`: Total deductions amount (from `total_deductions`)
- `total`: Net salary amount (from `net_salary`)
- `status`: Payroll record status (`DRAFT`, `PROCESSED`, `PAID`, `CANCELLED`)
- `date`: Payroll period date in ISO format (YYYY-MM-DD, e.g., "2024-06-01")
- `payslip_url`: URL to payslip PDF (can be `null` if not generated)

**Notes:**
- Only accessible to `admin` and `hr` roles.
- Excludes soft-deleted employees.
- Search matches across first_name, last_name, employee_id, and official_email.
- Sorting by `NAME` sorts by first_name then last_name.
- Default sorting is by date (most recent first).
- Values are returned as numbers (not formatted as currency) - frontend should format them as needed.
- `allowances`, `overtime`, and `incentives` can be `null` if not set.

### 39.11: Admin/HR - Download Payslip

Download payslip PDF for a specific payroll record. The payslip is generated on-demand and includes employee details, earnings breakdown, deductions, and net salary in a standard PDF format.

**Download Payslip:**
```
curl -X GET "http://localhost:3000/api/payroll/admin/records/{{payrollRecordId}}/payslip" \
  -H "Authorization: Bearer <TOKEN_B>" \
  --output payslip.pdf
```

**Path Parameters:**
- `id`: Payroll record UUID

**Expected Response:**
- HTTP 200 with PDF file (Content-Type: application/pdf)
- File is downloaded with filename: `payslip-{employee_id}-{year}-{month}.pdf`
- Example: `payslip-EMP-0234-2024-06.pdf`

**Payslip PDF Contents:**
- Header: "PAYSLIP" title and organization name
- Employee Information:
  - Employee Name
  - Employee ID
  - Email
- Pay Period: Month and Year (e.g., "June 2024")
- Earnings Section:
  - Salary components (from component_breakdown)
  - Overtime amount (if applicable)
  - Incentive amount (if applicable)
  - Bonus amount (if applicable)
  - Allowance amount (if applicable)
  - Total Earnings
- Deductions Section:
  - Deduction components (from component_breakdown)
  - PF Contribution (if applicable)
  - ESI Contribution (if applicable)
  - Income Tax / TDS (if applicable)
  - Professional Tax (if applicable)
  - Total Deductions
- Net Salary: Final amount after all deductions
- Footer: Generation date and system-generated notice

**Notes:**
- Only accessible to `admin` and `hr` roles.
- Payslip is generated on-demand (not pre-generated).
- PDF format is A4 size with standard payslip layout.
- All monetary values are displayed in the currency format (₹).
- Returns HTTP 404 if payroll record not found or doesn't belong to the organization.
- The payslip includes all earnings and deductions from the payroll record.

### 39.12: Admin/HR - Adjust Employee Salary

Get and update payroll adjustment data for a specific payroll record.

**Get Payroll Adjustment Data:**
```
curl -X GET "http://localhost:3000/api/payroll/admin/adjust/{{payrollRecordId}}" \
  -H "Authorization: Bearer <TOKEN_B>"
```

**Path Parameters:**
- `id`: Payroll record UUID (not user ID)

**Expected Response (HTTP 200):**
```json
{
  "employee": {
    "name": "Olivia Mason",
    "department": "Marketing"
  },
  "summary": {
    "worked_days": 22,
    "total_working_days": 24,
    "overtime_hours": 2.5,
    "unpaid_days": 0
  },
  "net_payable": {
    "salary_per_month": 3350,
    "fixed_salary": 3200,
    "added_amount": 300,
    "deductions": 150
  },
  "incentives": [
    {
      "name": "Overtime",
      "amount": 60
    },
    {
      "name": "Perf. Incentive",
      "amount": 150
    }
  ],
  "extra_deductions": [
    {
      "name": "Tax",
      "amount": 120
    }
  ]
}
```

**Field Details:**
- `employee.name`: Employee's full name
- `employee.department`: Department name
- `summary.worked_days`: Number of days with both clock in and clock out
- `summary.total_working_days`: Total working days in the month (excluding weekends)
- `summary.overtime_hours`: Total shift-based overtime hours for the payroll month (net work minus expected shift span, breaks deducted; same rules as `GET /api/attendance/admin/users`). Returns `0` when no shift is configured.
- `summary.unpaid_days`: `total_working_days - worked_days` (non-negative)
- `net_payable.salary_per_month`: Same as payroll list `total` for this record (LOP-prorated payslip net payable plus adjustment incentives minus adjustment deductions)
- `net_payable.fixed_salary`: Same as payroll list `net_salary` (prorated base net before adjustment line items)
- `net_payable.added_amount`: Same as payroll list `incentives` (sum of `adjustment_incentives`)
- `net_payable.deductions`: Same as payroll list `deductions` (sum of `adjustment_extra_deductions`)
- `incentives`: Array of incentive items (name and amount)
- `extra_deductions`: Array of extra deduction items (name and amount)

**Update Payroll Adjustment:**
```
curl -X PUT "http://localhost:3000/api/payroll/admin/adjust/{{userId}}?month=6&year=2024" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_B>" \
  -d '{
    "salary_per_month": 3400,
    "fixed_salary": 3200,
    "added_amount": 350,
    "incentives": [
      {
        "name": "Overtime",
        "amount": 70
      },
      {
        "name": "Perf. Incentive",
        "amount": 150
      }
    ],
    "extra_deductions": [
      {
        "name": "Tax",
        "amount": 120
      }
    ]
  }'
```

**Request Body Fields:**
- `salary_per_month` (optional): Net salary for the month
- `fixed_salary` (optional): Base/fixed salary amount
- `added_amount` (optional): Additional allowances/amounts
- `incentives` (optional): Array of incentive items, each with:
  - `name`: Incentive name (e.g., "Overtime", "Perf. Incentive", "Bonus")
  - `amount`: Incentive amount (non-negative number)
- `extra_deductions` (optional): Array of deduction items, each with:
  - `name`: Deduction name (e.g., "Tax", "Professional Tax")
  - `amount`: Deduction amount (non-negative number)

**Expected Response (HTTP 200 or 201):**
```json
{
  "id": "uuid",
  "user_id": "uuid",
  "org_id": "uuid",
  "payroll_month": 6,
  "payroll_year": 2024,
  "gross_salary": 3200,
  "total_earnings": 3570,
  "total_deductions": 120,
  "net_salary": 3400,
  "allowance_amount": 350,
  "overtime_amount": 70,
  "incentive_amount": 150,
  "bonus_amount": 0,
  "status": "DRAFT",
  ...
}
```

**Notes:**
- Only accessible to `admin` and `hr` roles.
- Returns HTTP 404 if payroll record not found.
- Uses payroll record ID (not user ID) - month and year are retrieved from the payroll record itself.
- `worked_days` is calculated from attendance logs (days with both clock in and clock out).
- `overtime_hours` is the sum of daily shift-based overtime for the month (matches attendance admin logic), not a fixed 8-hours-per-day rule.
- `unpaid_days` is `total_working_days - worked_days` (minimum 0).
- Incentives are automatically categorized:
  - Items with "overtime" in name → `overtime_amount`
  - Items with "bonus" in name → `bonus_amount`
  - Other items → `incentive_amount`
- Deductions with "tax" in name (excluding "professional") → `income_tax`
- Deductions with "professional" in name → `professional_tax`
- `total_earnings` = `fixed_salary` + `added_amount` + sum of all incentives
- `total_deductions` = existing deductions + sum of all extra deductions
- `net_salary` = `total_earnings` - `total_deductions` (or `salary_per_month` if provided)  