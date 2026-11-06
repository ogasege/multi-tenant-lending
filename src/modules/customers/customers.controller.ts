import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AuthThrottle } from '../../common/auth/auth-throttle';
import {
  CurrentTenantUser,
  Public,
  RequirePermissions,
  type TenantUser,
} from '../../common/auth/decorators';
import { Permission } from '../../common/auth/permissions';
import { PageQueryDto } from '../../common/http/pagination';
import { ApiProblemResponses } from '../../common/http/problem-responses';

import { GetCustomer, GetMyCustomer, ListCustomers } from './customer-queries.use-case';
import {
  CustomerDto,
  CustomerPageDto,
  CustomerRegistrationDto,
  RegisterCustomerDto,
} from './customer.dto';
import { RegisterCustomer } from './register-customer.use-case';

@ApiTags('Customers')
@Controller()
export class CustomersController {
  constructor(
    private readonly register: RegisterCustomer,
    private readonly getMine: GetMyCustomer,
    private readonly getOne: GetCustomer,
    private readonly list: ListCustomers,
  ) {}

  @Post('institutions/:slug/customers/register')
  @Public()
  @AuthThrottle()
  @ApiOperation({ summary: 'Customer self-registration (borrower business + owner KYC)' })
  @ApiParam({ name: 'slug', example: 'lagos-health-credit' })
  @ApiCreatedResponse({ type: CustomerRegistrationDto })
  @ApiProblemResponses(400, 403, 404, 409, 422, 429)
  signUp(
    @Param('slug') slug: string,
    @Body() dto: RegisterCustomerDto,
  ): Promise<CustomerRegistrationDto> {
    return this.register.execute(slug, dto);
  }

  @Get('customers/me')
  @ApiBearerAuth()
  @RequirePermissions(Permission.CUSTOMER_READ)
  @ApiOperation({ summary: 'The signed-in customer’s profile' })
  @ApiOkResponse({ type: CustomerDto })
  @ApiProblemResponses(401, 403, 404)
  me(@CurrentTenantUser() principal: TenantUser): Promise<CustomerDto> {
    return this.getMine.execute(principal);
  }

  @Get('customers')
  @ApiBearerAuth()
  @RequirePermissions(Permission.CUSTOMER_READ)
  @ApiOperation({ summary: 'List customers (staff only, cursor pagination)' })
  @ApiOkResponse({ type: CustomerPageDto })
  @ApiProblemResponses(400, 401, 403)
  findAll(
    @CurrentTenantUser() principal: TenantUser,
    @Query() query: PageQueryDto,
  ): Promise<CustomerPageDto> {
    return this.list.execute(principal, query);
  }

  @Get('customers/:id')
  @ApiBearerAuth()
  @RequirePermissions(Permission.CUSTOMER_READ)
  @ApiOperation({ summary: 'Get a customer (customers: own record only)' })
  @ApiOkResponse({ type: CustomerDto })
  @ApiProblemResponses(400, 401, 403, 404)
  findOne(
    @CurrentTenantUser() principal: TenantUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerDto> {
    return this.getOne.execute(principal, id);
  }
}
