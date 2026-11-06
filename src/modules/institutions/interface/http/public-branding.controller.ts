import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../../../../common/auth/decorators';
import { ApiProblemResponses } from '../../../../common/http/problem-responses';
import { GetPublicBranding } from '../../application/get-public-branding.use-case';
import type { PublicBranding } from '../../infrastructure/branding-cache';

import { PublicBrandingDto } from './dto/branding.dto';

/** Unauthenticated white-label configuration for borrower-facing front ends. */
@ApiTags('Institution')
@Controller('institutions')
export class PublicBrandingController {
  constructor(private readonly getPublicBranding: GetPublicBranding) {}

  @Get(':slug/branding')
  @Public()
  @ApiOperation({
    summary: 'Public branding of an institution by slug',
    description: 'Cached for 60 s. Unknown or suspended institutions return 404.',
  })
  @ApiParam({ name: 'slug', example: 'acme-mfb' })
  @ApiOkResponse({ type: PublicBrandingDto })
  @ApiProblemResponses(404, 429)
  async branding(
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicBranding> {
    const branding = await this.getPublicBranding.execute(slug);
    // Only on 200: a 404 (unknown or suspended) is never stored by shared caches.
    res.setHeader('Cache-Control', 'public, max-age=60');
    return branding;
  }
}
