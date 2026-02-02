// Minimal API client using fetch. Base URL from VITE_API_BASE or default.

// Prefer relative base so Vite dev proxy handles CORS in dev.
const explicitBase = (import.meta.env.VITE_API_BASE ?? '').trim();
const API_BASE = explicitBase || (import.meta.env.MODE === 'test' ? 'http://localhost:8000' : '');

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Accept': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export type StravaStatus = {
  connected: boolean;
  expires_at: number | null;
  scope: string | null;
};

export async function getStravaStatus(): Promise<StravaStatus> {
  return http<StravaStatus>('/api/auth/strava/status');
}

export type AuthInit = { auth_url: string };

export async function getAuthInit(): Promise<AuthInit> {
  return http<AuthInit>('/api/auth/strava/init');
}

export type SessionInfo = {
  authenticated: boolean;
  athlete_id?: number | null;
  firstname?: string | null;
  lastname?: string | null;
  username?: string | null;
};

export async function logout(): Promise<SessionInfo> {
  return http<SessionInfo>('/api/logout', {
    method: 'POST',
  });
}

export async function getSession(): Promise<SessionInfo> {
  return http<SessionInfo>('/api/session');
}

export type Activity = {
  id: number;
  start_date: string | null;
  start_date_local: string | null;
  sport_type: string | null;
  name: string | null;
  device_name?: string | null;
  distance: number | null;
  moving_time: number | null;
  elapsed_time: number | null;
  total_elevation_gain: number | null;
  description?: string | null;
  start_lat?: number | null;
  start_lng?: number | null;
  end_lat?: number | null;
  end_lng?: number | null;
  commute?: boolean | null;
  workout_type?: number | null;
  gear_id?: string | null;
  hide_from_home?: boolean | null;
};

export type ActivitiesPage = {
  total: number;
  items: Activity[];
};

export async function getActivities(limit = 10, offset = 0, sport?: string): Promise<ActivitiesPage> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (sport && sport.trim()) params.set('sport', sport.trim());
  return http<ActivitiesPage>(`/api/activities?${params.toString()}`);
}

export type ShoeStatsItem = {
  gear_id: string;
  name: string;
  is_primary: boolean;
  lifetime_distance: number | null;
  activity_count: number;
  total_distance: number;
  total_moving_time: number;
  avg_cadence: number | null;
  avg_pace_s_per_km: number | null;
  first_activity_at: string | null;
  last_activity_at: string | null;
};

export type ShoeStatsResponse = {
  items: ShoeStatsItem[];
};

export async function getShoeStats(): Promise<ShoeStatsResponse> {
  return http<ShoeStatsResponse>('/api/gear/shoes');
}

export { API_BASE };

// Automations ---------------------------------------------------------------

export type Condition = {
  type: string;
  op: string;
  value: unknown;
};

export type Effect = {
  type: string;
  params?: Record<string, unknown>;
};

export type Automation = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: Condition[];
  effects: Effect[];
  created_at: string;
  updated_at: string;
};

export type AutomationCreate = {
  name: string;
  enabled: boolean;
  priority: number;
  conditions: Condition[];
  effects: Effect[];
};

export async function getAutomations(): Promise<Automation[]> {
  return http<Automation[]>('/api/automations');
}

export async function createAutomation(a: AutomationCreate): Promise<Automation> {
  return http<Automation>('/api/automations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(a),
  });
}

export async function deleteAutomation(id: string): Promise<void> {
  await http<void>(`/api/automations/${id}`, { method: 'DELETE' });
}

export async function setAutomationEnabled(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
  return http<{ id: string; enabled: boolean }>(`/api/automations/${id}/enabled`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

export async function updateAutomation(id: string, a: Partial<AutomationCreate>): Promise<Automation> {
  return http<Automation>(`/api/automations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(a),
  })
}

export async function getAutomation(id: string): Promise<Automation> {
  return http<Automation>(`/api/automations/${id}`)
}

// Strava disconnect ---------------------------------------------------------

export async function disconnectStrava(): Promise<{ connected: false }> {
  return http<{ connected: false }>(`/api/auth/strava/disconnect`, { method: 'POST' });
}

// Admin ---------------------------------------------------------------------

export type IngestDebug = { count_before: number; count_after: number; cursor_before: number; cursor_after: number }
export type IngestResponse = {
  inserted: number;
  updated: number;
  cursor: number | null;
  message?: string;
  since?: number | null;
  cooldown?: Record<string, unknown>;
  debug?: IngestDebug;
}

export async function runIngestNow(since?: string): Promise<IngestResponse> {
  const body = since ? JSON.stringify({ since }) : undefined
  return http<IngestResponse>(`/api/admin/ingest`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body,
  })
}

export async function deleteActivity(id: number): Promise<void> {
  await http<void>(`/api/activities/${id}`, { method: 'DELETE' })
}

export async function clearActivities(): Promise<{ deleted: number }> {
  return http<{ deleted: number }>(`/api/activities/clear`, { method: 'POST' })
}

export type ActivityRefreshResult = {
  updated: boolean;
  message?: string;
  cooldown?: Record<string, unknown>;
  applied_fields?: string[];
  activity_id?: number;
}

export async function refreshActivity(id: number): Promise<ActivityRefreshResult> {
  return http<ActivityRefreshResult>(`/api/activities/${id}/refresh`, { method: 'POST' })
}

// Per-activity preview/apply -------------------------------------------------

export type ActivityPreview = {
  activity_id: number;
  applies: boolean;
  desired: { name?: string | null; sport_type?: string | null; commute?: boolean | null; workout_type?: number | null };
  matched_automations: { id: string; name: string }[];
}

export async function previewActivity(id: number): Promise<ActivityPreview> {
  return http<ActivityPreview>(`/api/activities/${id}/preview`)
}

export async function applyActivity(id: number): Promise<{ updated: boolean; changes: Record<string, unknown>; applies: boolean; matched_automations: { id: string; name: string }[] }> {
  return http<{ updated: boolean; changes: Record<string, unknown>; applies: boolean; matched_automations: { id: string; name: string }[] }>(`/api/activities/${id}/apply`, { method: 'POST' })
}

export type AuditItem = { id: string; source: string; automation_ids: string[]; changes: Record<string, unknown>; error: string | null; created_at: string }
export async function getActivityAudit(id: number, limit = 20): Promise<{ items: AuditItem[] }> {
  const params = new URLSearchParams({ limit: String(limit) })
  return http<{ items: AuditItem[] }>(`/api/activities/${id}/audit?${params.toString()}`)
}

// Gear ----------------------------------------------------------------------

export type GearItem = { id: string; name: string; primary: boolean; distance?: number }
export async function getAthleteGear(): Promise<{ shoes: GearItem[] }> {
  return http<{ shoes: GearItem[] }>(`/api/athlete/gear`)
}

// Geocoding -----------------------------------------------------------------

export type GeocodeItem = { lat: number; lon: number; display_name: string }
export async function geocode(q: string, limit = 5): Promise<{ items: GeocodeItem[] }> {
  const params = new URLSearchParams({ q, limit: String(limit) })
  return http<{ items: GeocodeItem[] }>(`/api/geocode?${params.toString()}`)
}

export async function reverseGeocode(lat: number, lon: number): Promise<{ display_name: string; lat: number; lon: number }> {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon) })
  return http<{ display_name: string; lat: number; lon: number }>(`/api/reverse?${params.toString()}`)
}

// Rate limit metrics ---------------------------------------------------------

export type RateLimitMetrics = {
  now: number;
  cooldown_until: number;
  cooldown_until_local: string;
  cooldown_reason: string;
  cooldown_scope: string;
  cooldown_set_at: number;
  cooldown_message: string;
  requests_15m: number;
  requests_24h: number;
  errors_429_15m: number;
  errors_429_24h: number;
  last_headers: { usage_min: number | null; usage_day: number | null; limit_min: number | null; limit_day: number | null; last_status: number | null } | null;
  webhook: {
    subscription_id: string;
    last_event_epoch: number;
    last_event_local: string;
    last_activity_id: number;
    last_event_aspect: string;
    last_error: string;
  };
}

export async function getRateLimitMetrics(): Promise<RateLimitMetrics> {
  return http<RateLimitMetrics>('/api/admin/ratelimit')
}

export type WebhookStatus = {
  subscription_id: string;
  callback_url: string;
  verify_token_set: boolean;
  last_event_epoch: number;
  last_event_local: string;
  last_activity_id: number;
  last_event_aspect: string;
  last_error: string;
}

export async function getWebhookStatus(): Promise<WebhookStatus> {
  return http<WebhookStatus>('/api/admin/webhooks/status')
}

export async function subscribeWebhook(): Promise<{ subscription: Record<string, unknown> }> {
  return http<{ subscription: Record<string, unknown> }>('/api/admin/webhooks/subscribe', { method: 'POST' })
}

export async function unsubscribeWebhook(): Promise<{ deleted: boolean; subscription_id?: string; message?: string }> {
  return http<{ deleted: boolean; subscription_id?: string; message?: string }>('/api/admin/webhooks/unsubscribe', { method: 'POST' })
}

// Counters ------------------------------------------------------------------

export type CounterItem = { key: string; value: number }
export async function getCounters(): Promise<{ items: CounterItem[]; total: number }> {
  return http<{ items: CounterItem[]; total: number }>(`/api/counters`)
}

export async function setCounter(key: string, value: number): Promise<{ key: string; value: number }> {
  return http<{ key: string; value: number }>(`/api/counters/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
}

export async function resetCounter(key: string): Promise<{ key: string; value: number }> {
  return http<{ key: string; value: number }>(`/api/counters/${encodeURIComponent(key)}/reset`, { method: 'POST' })
}

export async function resetAllCounters(): Promise<{ reset: number }> {
  return http<{ reset: number }>(`/api/counters/reset_all`, { method: 'POST' })
}

export async function reapplyCounters(dryRun = false, limit?: number): Promise<{ updated: number; skipped: number; applied_ids: number[]; dry_run: boolean }> {
  const body: Record<string, unknown> = { dry_run: Boolean(dryRun) }
  if (Number.isFinite(limit as number)) body.limit = Number(limit)
  return http<{ updated: number; skipped: number; applied_ids: number[]; dry_run: boolean }>(`/api/admin/reapply_counters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function reapplyAutomations(since: string, dryRun = false, limit?: number): Promise<{ updated: number; skipped: number; applied_ids: number[]; dry_run: boolean }> {
  const body: Record<string, unknown> = { since, dry_run: Boolean(dryRun) }
  if (Number.isFinite(limit as number)) body.limit = Number(limit)
  return http<{ updated: number; skipped: number; applied_ids: number[]; dry_run: boolean }>(`/api/admin/reapply_automations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
