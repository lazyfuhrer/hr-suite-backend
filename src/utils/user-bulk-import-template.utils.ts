import ExcelJS from 'exceljs';

import {
  BULK_IMPORT_CANONICAL_HEADERS,
  BULK_IMPORT_MAX_ROWS,
} from '../validators/tenant/user-bulk-import.validator';

export type BulkImportTemplateDepartment = {
  id: string;
  name: string;
};

function buildExampleRow(
  departments: BulkImportTemplateDepartment[],
): Record<(typeof BULK_IMPORT_CANONICAL_HEADERS)[number], string | number | boolean> {
  const firstDepartment = departments[0];

  return {
    employee_id: 'EMP001',
    first_name: 'Anita',
    last_name: 'Verma',
    role: 'employee',
    official_email: 'anita@company.com',
    phone_number: '+919876543210',
    alt_phone: '9876543210',
    gender: 'FEMALE',
    dob: '1995-06-15',
    personal_email: 'anita.personal@example.com',
    blood_group: 'O+',
    marital_status: 'SINGLE',
    nationality: 'Indian',
    emergency_contact_name: 'Raj Verma',
    emergency_contact_phone: '9876543210',
    emergency_contact_relation: 'Father',
    department_name: firstDepartment?.name ?? '',
    department_id: '',
    designation: 'Software Engineer',
    date_of_joining: '2026-03-01',
    employment_type: 'FULL_TIME',
    work_mode: 'ONSITE',
    shift_mode: 'day',
    send_welcome_email: false,
    annual_ctc: 600000,
    basic_salary: 300000,
    hra: 105000,
    other_allowance: 171000,
    gross_earnings: 576000,
    employer_pf: 24000,
    employer_total_contributions: 24000,
    employee_pf: 15000,
    professional_tax: 28000,
    total_deductions: 43000,
    salary_per_month: 44417,
  };
}

function columnIndexToLetter(index: number): string {
  let letter = '';
  let current = index;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    current = Math.floor((current - 1) / 26);
  }
  return letter;
}

function applyDepartmentNameValidation(
  dataSheet: ExcelJS.Worksheet,
  departmentNameColumnIndex: number,
  departmentCount: number,
): void {
  if (departmentCount === 0 || departmentNameColumnIndex < 1) return;

  const columnLetter = columnIndexToLetter(departmentNameColumnIndex);
  const validationFormula = `Departments!$B$2:$B$${departmentCount + 1}`;
  const validation = {
    type: 'list' as const,
    allowBlank: true,
    formulae: [validationFormula],
    showErrorMessage: true,
    errorTitle: 'Invalid department',
    error: 'Pick a department from the dropdown list',
  };

  for (let row = 2; row <= BULK_IMPORT_MAX_ROWS + 1; row += 1) {
    dataSheet.getCell(`${columnLetter}${row}`).dataValidation = validation;
  }
}

export async function buildBulkImportTemplateBuffer(
  departments: BulkImportTemplateDepartment[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'HR Management';
  workbook.created = new Date();

  const departmentsSheet = workbook.addWorksheet('Departments');
  departmentsSheet.addRow(['department_id', 'department_name']);
  for (const department of departments) {
    departmentsSheet.addRow([department.id, department.name]);
  }
  departmentsSheet.getRow(1).font = { bold: true };
  departmentsSheet.getColumn(1).width = 38;
  departmentsSheet.getColumn(2).width = 28;

  const exampleRow = buildExampleRow(departments);
  const dataSheet = workbook.addWorksheet('Bulk Import', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  dataSheet.addRow([...BULK_IMPORT_CANONICAL_HEADERS]);
  dataSheet.addRow(BULK_IMPORT_CANONICAL_HEADERS.map((header) => exampleRow[header]));

  const headerRow = dataSheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  BULK_IMPORT_CANONICAL_HEADERS.forEach((_, index) => {
    const column = dataSheet.getColumn(index + 1);
    column.width = 22;
  });

  const departmentNameColumnIndex = BULK_IMPORT_CANONICAL_HEADERS.indexOf('department_name') + 1;
  applyDepartmentNameValidation(dataSheet, departmentNameColumnIndex, departments.length);

  const referenceSheet = workbook.addWorksheet('Reference');
  referenceSheet.addRow(['Field', 'Notes']);
  referenceSheet.addRow(['role', 'admin | hr | manager | employee']);
  referenceSheet.addRow([
    'employment_type',
    'FULL_TIME | PART_TIME | CONTRACT | INTERN | INTERNSHIP | FREELANCE',
  ]);
  referenceSheet.addRow(['work_mode', 'ONSITE | HYBRID | REMOTE']);
  referenceSheet.addRow(['shift_mode', 'day | night']);
  referenceSheet.addRow(['date_of_joining', 'Format: YYYY-MM-DD']);
  referenceSheet.addRow(['dob', 'Format: YYYY-MM-DD (date of birth)']);
  referenceSheet.addRow(['gender', 'MALE | FEMALE | OTHER']);
  referenceSheet.addRow(['marital_status', 'SINGLE | MARRIED | DIVORCED']);
  referenceSheet.addRow([
    'phone_number',
    'Indian numbers supported; +91 prefix is stripped to 10 digits',
  ]);
  referenceSheet.addRow([
    'alt_phone',
    'Optional alternate phone; same Indian 10-digit rules as phone_number',
  ]);
  referenceSheet.addRow(['personal_email', 'Must be unique within the organization']);
  referenceSheet.addRow([
    'emergency_contact_*',
    'If any emergency contact column is provided, name, phone, and relation are all required',
  ]);
  referenceSheet.addRow([
    'department_name',
    'Pick from dropdown (org departments). Preferred over department_id.',
  ]);
  referenceSheet.addRow([
    'department_id',
    'Optional UUID; see Departments sheet. Leave empty when using department_name.',
  ]);
  referenceSheet.addRow(['send_welcome_email', 'true | false']);
  referenceSheet.addRow([
    'payroll columns',
    'All payroll amounts are ANNUAL except salary_per_month (monthly). Leave payroll columns empty to skip salary setup.',
  ]);
  referenceSheet.addRow(['max_rows', '200 rows per import']);
  referenceSheet.getRow(1).font = { bold: true };
  referenceSheet.getColumn(1).width = 24;
  referenceSheet.getColumn(2).width = 80;

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export const BULK_IMPORT_TEMPLATE_FILENAME = 'bulk_user_import_template.xlsx';
