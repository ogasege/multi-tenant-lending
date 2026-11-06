import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  CurrentTenantUser,
  RequirePermissions,
  type TenantUser,
} from '../../common/auth/decorators';
import { Permission } from '../../common/auth/permissions';
import { PageQueryDto } from '../../common/http/pagination';
import { ApiProblemResponses } from '../../common/http/problem-responses';

import { CreateUser } from './create-user.use-case';
import { ListUsers } from './list-users.use-case';
import { UpdateUser } from './update-user.use-case';
import { CreateUserDto, UpdateUserDto, UserDto, UserPageDto } from './user.dto';

@ApiTags('Users')
@ApiBearerAuth()
@RequirePermissions(Permission.USER_MANAGE)
@Controller('users')
export class UsersController {
  constructor(
    private readonly listUsers: ListUsers,
    private readonly createUser: CreateUser,
    private readonly updateUser: UpdateUser,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List staff users of the institution (cursor pagination)' })
  @ApiOkResponse({ type: UserPageDto })
  @ApiProblemResponses(400, 401, 403)
  findAll(@Query() query: PageQueryDto): Promise<UserPageDto> {
    return this.listUsers.execute(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a staff user (staff roles only)' })
  @ApiCreatedResponse({ type: UserDto })
  @ApiProblemResponses(400, 401, 403, 409)
  create(@CurrentTenantUser() actor: TenantUser, @Body() dto: CreateUserDto): Promise<UserDto> {
    return this.createUser.execute(actor.tenantId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a staff user’s role or status (audited)' })
  @ApiOkResponse({ type: UserDto })
  @ApiProblemResponses(400, 401, 403, 404)
  update(
    @CurrentTenantUser() actor: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserDto> {
    return this.updateUser.execute(actor.id, id, dto);
  }
}
