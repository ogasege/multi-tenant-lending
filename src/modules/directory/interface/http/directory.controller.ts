import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../../../../common/auth/decorators';
import { ApiProblemResponses } from '../../../../common/http/problem-responses';
import {
  type DirectoryEntryView,
  GetDirectoryEntry,
} from '../../application/get-directory-entry.use-case';

import { DirectoryEntryDto } from './dto/directory-entry.dto';

/**
 * Global tenant directory (SPEC §4.1): lets white-label front ends discover an institution's
 * home cell once and then talk to it directly. Answered by every cell.
 */
@ApiTags('Directory')
@Controller('directory')
export class DirectoryController {
  constructor(private readonly getEntry: GetDirectoryEntry) {}

  @Get('institutions/:slug')
  @Public()
  @ApiOperation({
    summary: 'Home cell of an institution',
    description:
      'Public; successful answers are cacheable for 60 s. Unknown and suspended institutions ' +
      'return 404 (never cached publicly).',
  })
  @ApiParam({ name: 'slug', example: 'acme-mfb' })
  @ApiOkResponse({ type: DirectoryEntryDto })
  @ApiProblemResponses(404, 429)
  async institution(
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DirectoryEntryView> {
    const entry = await this.getEntry.execute(slug);
    // Only on 200: a shared cache must not keep a 404 (e.g. a just-registered tenant).
    res.setHeader('Cache-Control', 'public, max-age=60');
    return entry;
  }
}
