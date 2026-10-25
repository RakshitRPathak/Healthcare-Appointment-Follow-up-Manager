import { config } from '../config';

export interface CalendarEvent { eventId: string; refreshToken: string; title: string; startAt: Date; endAt: Date; timeZone: string }
export interface CalendarClient {
  createEvent(e: CalendarEvent): Promise<void>;            // must be idempotent on eventId
  deleteEvent(a: { eventId: string; refreshToken: string }): Promise<void>;   // must treat "already gone" as success
}

export class GoogleCalendar implements CalendarClient {
  private async token(refreshToken: string) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ client_id: config.google.clientId ?? '', client_secret: config.google.clientSecret ?? '',
                                  refresh_token: refreshToken, grant_type: 'refresh_token' }) });
    if (!res.ok) throw new Error(`google token ${res.status}`);
    return ((await res.json()) as any).access_token as string;
  }
  async createEvent(e: CalendarEvent) {
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${await this.token(e.refreshToken)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: e.eventId, summary: e.title,               // client-chosen id => retries can't duplicate
        start: { dateTime: e.startAt.toISOString(), timeZone: e.timeZone }, end: { dateTime: e.endAt.toISOString(), timeZone: e.timeZone } }) });
    if (res.status === 409) return;                                          // already created by an earlier attempt
    if (!res.ok) throw new Error(`google create ${res.status}`);
  }
  async deleteEvent(a: { eventId: string; refreshToken: string }) {
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${a.eventId}`, {
      method: 'DELETE', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${await this.token(a.refreshToken)}` } });
    if (res.status === 404 || res.status === 410) return;
    if (!res.ok) throw new Error(`google delete ${res.status}`);
  }
}
