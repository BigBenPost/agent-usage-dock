/**
 * The zones the times on session cards and in the session popup can be shown in. Both have a fixed offset all year, so an offset
 * is all that is needed. Billing months and days stay UTC whatever is chosen here: a session just reads in the viewer's own time.
 */
export type DisplayZone = 'UTC' | 'SGT';

export const DISPLAY_ZONES: Record<DisplayZone, { offsetMinutes: number; name: string }> = {
  UTC: { offsetMinutes: 0, name: 'UTC' },
  SGT: { offsetMinutes: 8 * 60, name: 'Singapore time, UTC+8' },
};

export const ZONE_ORDER: readonly DisplayZone[] = ['UTC', 'SGT'];

export const isDisplayZone = (v: unknown): v is DisplayZone => typeof v === 'string' && Object.prototype.hasOwnProperty.call(DISPLAY_ZONES, v);

/** `10-29 13:29`: month, day, hour and minute of `ms` in `zone`. */
export function stamp(ms: number, zone: DisplayZone): string {
  return new Date(ms + DISPLAY_ZONES[zone].offsetMinutes * 60_000).toISOString().slice(5, 16).replace('T', ' ');
}
