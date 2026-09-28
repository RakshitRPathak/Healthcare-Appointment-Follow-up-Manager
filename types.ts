/** Fire-and-forget hooks called AFTER a DB commit. Losing one is safe: reconcile() re-derives them from DB state. */
export interface Jobs {
  summary(appointmentId: string, kind: 'PRE' | 'POST'): Promise<void>;
  calendar(appointmentId: string): Promise<void>;
}
export const noopJobs: Jobs = { summary: async () => {}, calendar: async () => {} };
