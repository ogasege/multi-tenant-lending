import { ApiProperty } from '@nestjs/swagger';

import { Permission } from '../../common/auth/permissions';
import type { UserRole } from '../../common/database/schema';

const ROLES: UserRole[] = [
  'INSTITUTION_ADMIN',
  'CREDIT_OFFICER',
  'FINANCE_OFFICER',
  'AUDITOR',
  'CUSTOMER',
];

export class MeInstitutionDto {
  @ApiProperty({ example: 'eko-medicredit' }) slug!: string;
  @ApiProperty({ example: 'Eko MediCredit' }) displayName!: string;
}

/** `GET /v1/me` for a tenant user (staff or customer). */
export class TenantUserMeDto {
  @ApiProperty({ enum: ['USER'] }) kind!: 'USER';
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Chidi Okeke' }) fullName!: string;
  @ApiProperty({ example: 'credit@eko-medicredit.example' }) email!: string;
  @ApiProperty({ enum: ROLES }) role!: UserRole;

  @ApiProperty({
    enum: Object.values(Permission),
    isArray: true,
    description: 'Permissions the role holds (drives which actions a client offers)',
  })
  permissions!: Permission[];

  @ApiProperty({ type: MeInstitutionDto }) institution!: MeInstitutionDto;
}

/** `GET /v1/me` for a platform administrator. */
export class PlatformAdminMeDto {
  @ApiProperty({ enum: ['PLATFORM_ADMIN'] }) kind!: 'PLATFORM_ADMIN';
  @ApiProperty({ format: 'uuid' }) id!: string;
}

export type MeView = TenantUserMeDto | PlatformAdminMeDto;
