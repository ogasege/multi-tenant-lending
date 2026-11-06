import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

/** Lower-cases and trims an email before validation; emails are unique case-insensitively. */
export const NormalisedEmail = () =>
  applyDecorators(
    ApiProperty({ format: 'email', maxLength: 254, example: 'ada@example.com' }),
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim().toLowerCase() : value,
    ),
    IsEmail(),
    MaxLength(254),
  );
