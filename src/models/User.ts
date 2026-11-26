import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class User extends BaseModel {
  static tableName = 'users';

  org_id!: string;
  employee_id!: string;
  first_name!: string;
  last_name!: string;
  official_email!: string;
  password_hash!: string;
  role!: string;
  status!: string;
  must_change_password!: boolean;
  employee_welcome_email_sent_at?: Date | string | null;
  manager_id?: string;
  department_id?: string | null;
  shift_id?: string | null;
  designation?: string;
  date_of_joining?: string;
  profile_image_url?: string | null;
  /** null = inherit from department; true/false = per-user override */
  location_tracking_enabled?: boolean | null;
  /** When set, tenant JWTs with iat before this timestamp are rejected */
  sessions_invalidated_at?: Date | string | null;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { Department } = require('./Department');
    const { WorkShift } = require('./WorkShift');
    const { AttendanceLog } = require('./AttendanceLog');
    const { LeaveRequest } = require('./LeaveRequest');
    const { UserProfile } = require('./UserProfile');
    const { EmergencyContact } = require('./EmergencyContact');
    const { Address } = require('./Address');
    const { UserIdentity } = require('./UserIdentity');
    const { BankDetail } = require('./BankDetail');
    const { UserDocument } = require('./UserDocument');
    const { UserOnboarding } = require('./UserOnboarding');
    const { UserExit } = require('./UserExit');
    const { UserAllowedLocation } = require('./UserAllowedLocation');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'users.org_id',
          to: 'organizations.id',
        },
      },
      department: {
        relation: Model.BelongsToOneRelation,
        modelClass: Department,
        join: {
          from: 'users.department_id',
          to: 'departments.id',
        },
      },
      shift: {
        relation: Model.BelongsToOneRelation,
        modelClass: WorkShift,
        join: {
          from: 'users.shift_id',
          to: 'work_shifts.id',
        },
      },
      manager: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'users.manager_id',
          to: 'users.id',
        },
      },
      directReports: {
        relation: Model.HasManyRelation,
        modelClass: User,
        join: {
          from: 'users.id',
          to: 'users.manager_id',
        },
      },
      attendanceLogs: {
        relation: Model.HasManyRelation,
        modelClass: AttendanceLog,
        join: {
          from: 'users.id',
          to: 'attendance_logs.user_id',
        },
      },
      leaveRequests: {
        relation: Model.HasManyRelation,
        modelClass: LeaveRequest,
        join: {
          from: 'users.id',
          to: 'leave_requests.user_id',
        },
      },
      profile: {
        relation: Model.HasOneRelation,
        modelClass: UserProfile,
        join: {
          from: 'users.id',
          to: 'user_profiles.user_id',
        },
      },
      emergencyContacts: {
        relation: Model.HasManyRelation,
        modelClass: EmergencyContact,
        join: {
          from: 'users.id',
          to: 'emergency_contacts.user_id',
        },
      },
      addresses: {
        relation: Model.HasManyRelation,
        modelClass: Address,
        join: {
          from: 'users.id',
          to: 'addresses.user_id',
        },
      },
      identities: {
        relation: Model.HasManyRelation,
        modelClass: UserIdentity,
        join: {
          from: 'users.id',
          to: 'user_identities.user_id',
        },
      },
      bankDetails: {
        relation: Model.HasOneRelation,
        modelClass: BankDetail,
        join: {
          from: 'users.id',
          to: 'bank_details.user_id',
        },
      },
      documents: {
        relation: Model.HasManyRelation,
        modelClass: UserDocument,
        join: {
          from: 'users.id',
          to: 'user_documents.user_id',
        },
      },
      onboarding: {
        relation: Model.HasOneRelation,
        modelClass: UserOnboarding,
        join: {
          from: 'users.id',
          to: 'user_onboardings.user_id',
        },
      },
      exits: {
        relation: Model.HasManyRelation,
        modelClass: UserExit,
        join: {
          from: 'users.id',
          to: 'user_exits.user_id',
        },
      },
      activeExit: {
        relation: Model.HasOneRelation,
        modelClass: UserExit,
        join: {
          from: 'users.id',
          to: 'user_exits.user_id',
        },
        filter: (builder: any) => {
          builder.whereIn('user_exits.status', ['SCHEDULED', 'ON_NOTICE', 'COMPLETED']);
        },
      },
      allowedLocations: {
        relation: Model.HasManyRelation,
        modelClass: UserAllowedLocation,
        join: {
          from: 'users.id',
          to: 'user_allowed_locations.user_id',
        },
      },
      employmentDetails: {
        relation: Model.HasOneRelation,

        modelClass: require('./EmployeeEmploymentDetail').EmployeeEmploymentDetail,
        join: {
          from: 'users.id',
          to: 'employee_employment_details.user_id',
        },
      },
      benefits: {
        relation: Model.HasManyRelation,

        modelClass: require('./EmployeeBenefit').EmployeeBenefit,
        join: {
          from: 'users.id',
          to: 'employee_benefits.user_id',
        },
      },
      payrollDetail: {
        relation: Model.HasOneRelation,
        modelClass: require('./UserPayrollDetail').UserPayrollDetail,
        join: {
          from: 'users.id',
          to: 'user_payroll_details.user_id',
        },
      },
      salaryStructures: {
        relation: Model.HasManyRelation,
        modelClass: require('./SalaryStructure').SalaryStructure,
        join: {
          from: 'users.id',
          to: 'salary_structures.user_id',
        },
      },
      payrollRecords: {
        relation: Model.HasManyRelation,
        modelClass: require('./PayrollRecord').PayrollRecord,
        join: {
          from: 'users.id',
          to: 'payroll_records.user_id',
        },
      },
    };
  }
}
