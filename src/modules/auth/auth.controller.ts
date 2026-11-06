import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthThrottle } from '../../common/auth/auth-throttle';
import { Public } from '../../common/auth/decorators';
import { RefreshTokenDto, TokenPairDto } from '../../common/auth/token-pair.dto';
import { ApiProblemResponses } from '../../common/http/problem-responses';

import { LoginDto } from './auth.dto';
import { Login } from './login.use-case';
import { Logout } from './logout.use-case';
import { Refresh } from './refresh.use-case';

@ApiTags('Auth')
@Public()
@AuthThrottle()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly login: Login,
    private readonly refresh: Refresh,
    private readonly logout: Logout,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in a staff user or customer of an institution' })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiProblemResponses(400, 401, 403, 429)
  signIn(@Body() dto: LoginDto): Promise<TokenPairDto> {
    return this.login.execute(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token (reuse of a used token revokes the family)' })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiProblemResponses(400, 401, 403, 429)
  rotate(@Body() dto: RefreshTokenDto): Promise<TokenPairDto> {
    return this.refresh.execute(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out: revoke the refresh token family' })
  @ApiNoContentResponse({ description: 'Session revoked (also returned for unknown tokens)' })
  @ApiProblemResponses(400, 429)
  signOut(@Body() dto: RefreshTokenDto): Promise<void> {
    return this.logout.execute(dto.refreshToken);
  }
}
