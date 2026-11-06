import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AuthModule } from '@/modules/auth/auth.module';
import { CustomersModule } from '@/modules/customers/customers.module';
import { CreatePlatformAdmin } from '@/modules/platform/admins/create-platform-admin.use-case';
import { PlatformModule } from '@/modules/platform/platform.module';
import { UsersModule } from '@/modules/users/users.module';

/** Feature modules under test until they are registered in AppModule. */
export const IDENTITY_MODULES = [PlatformModule, AuthModule, UsersModule, CustomersModule];

export const STRONG_PASSWORD = 'Sup3r-Secret-Pass';

/** Creates a platform admin the way the operator CLI does. */
export async function createPlatformAdmin(
  app: INestApplication,
  password = STRONG_PASSWORD,
): Promise<{ id: string; email: string; password: string }> {
  const admin = await app.get(CreatePlatformAdmin).execute({
    email: `ops-${randomUUID().slice(0, 8)}@platform.test`,
    fullName: 'Platform Ops',
    password,
  });
  return { ...admin, password };
}

/** Builds a valid customer self-registration body; override any field. */
export function customerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const n = Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, '0');
  return {
    businessName: 'HealthPlus Pharmacy Ltd',
    businessRegistrationNumber: `RC${n}`,
    operatingLicenceNumber: 'PCN/PREM/2024/0001',
    firstName: 'Amaka',
    lastName: 'Eze',
    email: `amaka-${n}@pharmacy.test`,
    phone: '+2348012345678',
    dateOfBirth: '1985-04-12',
    nationalId: `222${n}`,
    employmentStatus: 'BUSINESS_OWNER',
    monthsInEmployment: 48,
    currency: 'NGN',
    monthlyIncome: '150000000',
    monthlyExpenses: '60000000',
    existingMonthlyDebt: '0',
    password: STRONG_PASSWORD,
    ...overrides,
  };
}

export function registerCustomer(http: App, slug: string, overrides: Record<string, unknown> = {}) {
  return request(http)
    .post(`/v1/institutions/${slug}/customers/register`)
    .send(customerBody(overrides));
}

/** Typed views of response bodies (supertest bodies are `any`). */
export interface SessionBody {
  accessToken: string;
  refreshToken: string;
}

export interface StaffBody {
  id: string;
  email: string;
}

export interface RegistrationBody {
  customer: { id: string; reference: string };
  tokens: SessionBody;
}

export interface PageBody {
  items: { id: string; role?: string }[];
  nextCursor: string | null;
}

/** Decodes (without verifying) a JWT payload for claim assertions. */
export function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
}
