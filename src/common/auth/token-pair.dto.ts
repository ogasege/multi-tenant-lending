import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

import type { IssuedRefreshToken } from './refresh-token';

/** Access + refresh token pair returned by every sign-in and refresh endpoint. */
export class TokenPairDto {
  @ApiProperty({ description: 'JWT access token (HS256), sent as `Authorization: Bearer`' })
  accessToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty({ description: 'Access token lifetime in seconds', example: 900 })
  expiresIn!: number;

  @ApiProperty({ description: 'Opaque refresh token; single use, rotated on every refresh' })
  refreshToken!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  refreshTokenExpiresAt!: string;
}

/** Body of the tenant and platform refresh / logout endpoints. */
export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token from the previous sign-in or refresh' })
  @IsString()
  @Length(20, 200)
  refreshToken!: string;
}

export function toTokenPair(
  access: { accessToken: string; expiresIn: number },
  refresh: IssuedRefreshToken,
): TokenPairDto {
  return {
    accessToken: access.accessToken,
    tokenType: 'Bearer',
    expiresIn: access.expiresIn,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
  };
}
