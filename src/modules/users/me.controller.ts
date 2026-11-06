import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import { AnyTenantUser, CurrentPrincipal } from '../../common/auth/decorators';
import type { Principal } from '../../common/context/request-context';
import { ApiProblemResponses } from '../../common/http/problem-responses';

import { GetMe } from './get-me.use-case';
import { type MeView, PlatformAdminMeDto, TenantUserMeDto } from './me.dto';

/** The authenticated caller's own identity, for any principal. */
@ApiTags('Users')
@ApiBearerAuth()
@ApiExtraModels(TenantUserMeDto, PlatformAdminMeDto)
@Controller('me')
export class MeController {
  constructor(private readonly getMe: GetMe) {}

  @Get()
  @AnyTenantUser({ allowPlatformAdmin: true })
  @ApiOperation({
    summary: 'Who am I: the signed-in user, their role, permissions and institution',
    description:
      'Any signed-in tenant user (staff or customer) or platform admin. Returns only the ' +
      'caller’s own record; `kind` tells the two shapes apart.',
  })
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(TenantUserMeDto) },
        { $ref: getSchemaPath(PlatformAdminMeDto) },
      ],
      discriminator: { propertyName: 'kind' },
    },
  })
  @ApiProblemResponses(401, 403)
  me(@CurrentPrincipal() principal: Principal): Promise<MeView> {
    return this.getMe.execute(principal);
  }
}
