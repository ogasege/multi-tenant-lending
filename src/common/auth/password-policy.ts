import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { isStrongPassword, IsStrongPassword, MaxLength } from 'class-validator';

export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound keeps argon2 work per request bounded (hash-DoS protection). */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Password policy for every credential the API accepts at creation time: at least 12
 * characters with lower case, upper case and a digit (NIST SP 800-63B favours length; the
 * character classes are a pragmatic floor for staff accounts of a regulated lender).
 */
const STRENGTH = {
  minLength: PASSWORD_MIN_LENGTH,
  minLowercase: 1,
  minUppercase: 1,
  minNumbers: 1,
  minSymbols: 0,
};

export const PASSWORD_POLICY_MESSAGE = `password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters and contain upper case, lower case and a digit`;

/** The policy as a plain check, for inputs that do not arrive through a DTO (the CLI). */
export function meetsPasswordPolicy(password: string): boolean {
  return password.length <= PASSWORD_MAX_LENGTH && isStrongPassword(password, STRENGTH);
}

/** DTO decorator applying the policy. */
export const StrongPassword = () =>
  applyDecorators(
    ApiProperty({
      minLength: PASSWORD_MIN_LENGTH,
      maxLength: PASSWORD_MAX_LENGTH,
      format: 'password',
      description: 'At least 12 characters including upper case, lower case and a digit',
    }),
    IsStrongPassword(STRENGTH, { message: PASSWORD_POLICY_MESSAGE }),
    MaxLength(PASSWORD_MAX_LENGTH),
  );
