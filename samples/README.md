# Attendance bulk import samples

## `attendance_bulk_import_sample.xlsx`

Filled example workbook for testing the attendance bulk-import API (`POST /api/attendance/admin/bulk-import`).

Contains five rows across two placeholder employees (`anita@company.com`, `raj@company.com`) with `PRESENT`, `LATE`, and `ABSENT` statuses for July 2026.

**Before importing:** edit `official_email` values to match active employees in your organization.

## Regenerate

If import columns or instructions change, regenerate this file from the repo root:

```bash
npm run generate:attendance-bulk-import-sample
```
