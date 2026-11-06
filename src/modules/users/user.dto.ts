import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

import { StrongPassword } from '../../common/auth/password-policy';
import type { Row, UserRole } from '../../common/database/schema';
import { NormalisedEmail } from '../../common/http/normalised-email';
import { PageDto } from '../../common/http/pagination';

/** Roles that can be granted through staff management. CUSTOMER accounts only self-register. */
export const STAFF_ROLES = [
  'INSTITUTION_ADMIN',
  'CREDIT_OFFICER',
  'FINANCE_OFFICER',
  'AUDITOR',
] as const satisfies readonly UserRole[];
export type StaffRole = (typeof STAFF_ROLES)[number];

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export class CreateUserDto {
  @NormalisedEmail()
  email!: string;

  @ApiProperty({ example: 'Chidi Okeke' })
  @IsString()
  @Length(2, 200)
  fullName!: string;

  @ApiProperty({ enum: STAFF_ROLES })
  @IsIn(STAFF_ROLES, { message: `role must be one of ${STAFF_ROLES.join(', ')}` })
  role!: StaffRole;

  @StrongPassword()
  password!: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ enum: STAFF_ROLES })
  @IsOptional()
  @IsIn(STAFF_ROLES, { message: `role must be one of ${STAFF_ROLES.join(', ')}` })
  role?: StaffRole;

  @ApiPropertyOptional({ enum: USER_STATUSES })
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatus;
}

export class UserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: STAFF_ROLES }) role!: UserRole;
  @ApiProperty({ enum: USER_STATUSES }) status!: UserStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;

  /** Explicit mapping: password hash and lockout counters never leave the service. */
  static from(
    row: Pick<
      Row<'users'>,
      'id' | 'email' | 'full_name' | 'role' | 'status' | 'created_at' | 'updated_at'
    >,
  ): UserDto {
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}

export class UserPageDto extends PageDto(UserDto) {}

export const USER_COLUMNS = [
  'id',
  'email',
  'full_name',
  'role',
  'status',
  'created_at',
  'updated_at',
] as const;
