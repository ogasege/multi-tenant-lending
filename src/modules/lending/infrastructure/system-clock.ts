import { Injectable } from '@nestjs/common';

import { Clock } from '../application/ports/clock.port';

/** Production clock: the host's current instant. */
@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
