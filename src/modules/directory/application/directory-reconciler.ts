import { Inject, Injectable } from '@nestjs/common';

import { DirectoryProjector } from './directory-projector';
import {
  INSTITUTION_SNAPSHOTS,
  type InstitutionSnapshots,
  projectPendingInstitutions,
  type ReconcileSummary,
} from './project-pending-institutions';
import { ProjectionConflictReporter } from './projection-conflict';

/**
 * Nest entry point for the worker: reconcile the directory with this cell's institutions.
 * A `stale` result is usually "already up to date", but is reported as a conflict when
 * another institution or cell holds the slug.
 */
@Injectable()
export class DirectoryReconciler {
  constructor(
    @Inject(INSTITUTION_SNAPSHOTS) private readonly source: InstitutionSnapshots,
    private readonly projector: DirectoryProjector,
    private readonly conflicts: ProjectionConflictReporter,
  ) {}

  projectPendingInstitutions(): Promise<ReconcileSummary> {
    return projectPendingInstitutions(this.source, this.projector, (institution, current) =>
      this.conflicts.reportIfConflicting(institution.slug, institution.institutionId, current),
    );
  }
}
