import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH } from '../../../common/auth/password-policy';
import { NormalisedEmail } from '../../../common/http/normalised-email';

export class PlatformLoginDto {
  @NormalisedEmail()
  email!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
