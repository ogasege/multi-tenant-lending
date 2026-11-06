import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthThrottle } from '../../../common/auth/auth-throttle';
import { Public } from '../../../common/auth/decorators';
import { RefreshTokenDto, TokenPairDto } from '../../../common/auth/token-pair.dto';
import { ApiProblemResponses } from '../../../common/http/problem-responses';

import { PlatformLoginDto } from './platform-auth.dto';
import { PlatformLogin } from './platform-login.use-case';
import { PlatformRefresh } from './platform-refresh.use-case';

@ApiTags('Platform auth')
@Public()
@AuthThrottle()
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(
    private readonly login: PlatformLogin,
    private readonly refresh: PlatformRefresh,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Platform administrator sign-in (aud=platform token)' })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiProblemResponses(400, 401, 429)
  signIn(@Body() dto: PlatformLoginDto): Promise<TokenPairDto> {
    return this.login.execute(dto.email, dto.password);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a platform refresh token (reuse revokes the family)' })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiProblemResponses(400, 401, 429)
  rotate(@Body() dto: RefreshTokenDto): Promise<TokenPairDto> {
    return this.refresh.execute(dto.refreshToken);
  }
}
