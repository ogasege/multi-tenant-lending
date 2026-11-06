import { ApiProperty } from '@nestjs/swagger';

import type { DirectoryEntryView } from '../../../application/get-directory-entry.use-case';
import { DIRECTORY_STATUSES, type DirectoryStatus } from '../../../domain/directory-entry';

/** Where an institution's data and API live (its home cell). */
export class DirectoryEntryDto implements DirectoryEntryView {
  @ApiProperty({ example: 'acme-mfb' }) slug!: string;
  @ApiProperty({ example: 'af-south-1', description: 'AWS region of the home cell' })
  homeRegion!: string;
  @ApiProperty({
    example: 'https://af-south-1.api.example.com',
    description: 'Base URL to send this institution’s API requests to',
  })
  apiBaseUrl!: string;
  @ApiProperty({ enum: DIRECTORY_STATUSES }) status!: DirectoryStatus;
}
