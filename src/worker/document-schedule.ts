/** Exact cadence separation: the minute trigger never runs hourly cleanup. */
export function scheduledDocumentWork(cron: string): { asyncTick: boolean; hourlyCleanup: boolean } {
  return { asyncTick: cron === "* * * * *", hourlyCleanup: cron === "0 * * * *" };
}
