/**
 * Wall-clock port. Business "today" is derived from it in the institution's time zone; tests
 * freeze it (SPEC §6). Never call `new Date()` for business decisions outside an adapter.
 */
export abstract class Clock {
  abstract now(): Date;
}
