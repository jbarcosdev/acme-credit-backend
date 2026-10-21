const DAY_MS = 86_400_000;

export function dateOnly(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

export function nextCutDate(after: Date, cycleDay: number): Date {
  const base = dateOnly(after);
  const sameMonth = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), cycleDay),
  );
  if (sameMonth.getTime() > base.getTime()) return sameMonth;
  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, cycleDay),
  );
}
