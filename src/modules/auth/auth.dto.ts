import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches, MaxLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH } from '../../common/auth/password-policy';
import { NormalisedEmail } from '../../common/http/normalised-email';

export class LoginDto {
  @ApiProperty({ example: 'lagos-health-credit' })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'institutionSlug is not a valid slug' })
  @Length(3, 63)
  institutionSlug!: string;

  @NormalisedEmail()
  email!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
