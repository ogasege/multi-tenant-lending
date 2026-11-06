import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { PlatformAdminOnly } from '../../../common/auth/decorators';
import { PageQueryDto } from '../../../common/http/pagination';
import { ApiProblemResponses } from '../../../common/http/problem-responses';

import { ChangeInstitutionStatus } from './change-institution-status.use-case';
import {
  ChangeInstitutionStatusDto,
  InstitutionDto,
  InstitutionPageDto,
  RegisterInstitutionDto,
  RegisteredInstitutionDto,
} from './institution.dto';
import { ListInstitutions } from './list-institutions.use-case';
import { RegisterInstitution } from './register-institution.use-case';

@ApiTags('Platform institutions')
@ApiBearerAuth()
@PlatformAdminOnly()
@Controller('platform/institutions')
export class PlatformInstitutionsController {
  constructor(
    private readonly register: RegisterInstitution,
    private readonly list: ListInstitutions,
    private readonly changeStatus: ChangeInstitutionStatus,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Register an institution (tenant) with branding, chart of accounts and first admin',
  })
  @ApiCreatedResponse({ type: RegisteredInstitutionDto })
  @ApiProblemResponses(400, 401, 403, 409, 422)
  create(@Body() dto: RegisterInstitutionDto): Promise<RegisteredInstitutionDto> {
    return this.register.execute(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List institutions (cursor pagination, newest first)' })
  @ApiOkResponse({ type: InstitutionPageDto })
  @ApiProblemResponses(400, 401, 403)
  findAll(@Query() query: PageQueryDto): Promise<InstitutionPageDto> {
    return this.list.execute(query);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Suspend or reactivate an institution (audited)' })
  @ApiOkResponse({ type: InstitutionDto })
  @ApiProblemResponses(400, 401, 403, 404)
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeInstitutionStatusDto,
  ): Promise<InstitutionDto> {
    return this.changeStatus.execute(id, dto);
  }
}
