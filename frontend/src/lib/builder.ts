import type { Condition, Effect } from './api'

export type ConditionKind =
  | 'sport_type'
  | 'distance'
  | 'moving_time'
  | 'moving_pace'
  | 'total_elevation_gain'
  | 'title'
  | 'day_of_week'
  | 'start_near'
  | 'end_near'

export type ConditionOp = 'equals' | 'contains' | 'in' | 'not_in' | 'gt' | 'ge' | 'lt' | 'le' | 'eq'
  | 'within'

export const CONDITION_SPECS: Record<ConditionKind, { label: string; ops: ConditionOp[]; placeholder?: string }> = {
  sport_type: { label: 'Sport Type', ops: ['equals'], placeholder: 'e.g. Run' },
  distance: { label: 'Distance (m)', ops: ['gt', 'ge', 'lt', 'le', 'eq'], placeholder: 'e.g. 5000' },
  moving_time: { label: 'Moving time (s)', ops: ['gt', 'ge', 'lt', 'le', 'eq'], placeholder: 'e.g. 30:00 or 1800' },
  moving_pace: { label: 'Moving pace (s/km)', ops: ['gt', 'ge', 'lt', 'le', 'eq'], placeholder: 'e.g. 5:00 or 300' },
  total_elevation_gain: { label: 'Elevation gain (m)', ops: ['gt', 'ge', 'lt', 'le', 'eq'], placeholder: 'e.g. 300' },
  title: { label: 'Title', ops: ['contains'], placeholder: 'e.g. Commute' },
  day_of_week: { label: 'Day of week', ops: ['in', 'not_in'], placeholder: 'Mon,Wed,Fri' },
  start_near: { label: 'Start within radius of (lat/lon)', ops: ['within'], placeholder: 'lat,lon,radius(m)' },
  end_near: { label: 'End within radius of (lat/lon)', ops: ['within'], placeholder: 'lat,lon,radius(m)' },
}

export type EffectKind = 'set_title_suffix' | 'set_title_prefix' | 'set_commute' | 'set_sport_type' | 'set_long_run_tag' | 'set_shoes_by_id'
  | 'set_title_template'

export function conditionFrom(kind: ConditionKind, op: ConditionOp, raw: string | string[]): Condition {
  if (kind === 'sport_type') return { type: 'sport_type', op, value: String(raw).trim() }
  if (kind === 'title') return { type: 'title', op, value: String(raw).trim() }
  if (kind === 'day_of_week') {
    const arr = Array.isArray(raw) ? raw : String(raw).split(',').map((s) => s.trim()).filter(Boolean)
    return { type: 'day_of_week', op, value: arr }
  }
  if (kind === 'moving_time' || kind === 'moving_pace') {
    const secs = parseDurationSeconds(String(Array.isArray(raw) ? raw[0] ?? '' : raw))
    const value = Number.isFinite(secs as any) && secs !== null ? secs : Number(Array.isArray(raw) ? raw[0] ?? 0 : raw)
    return { type: kind, op, value }
  }
  if (kind === 'start_near' || kind === 'end_near') {
    // Raw expected as 'lat,lon,radius_m' OR an array [lat,lon,radius]
    let lat = 0, lon = 0, radius = 100
    if (Array.isArray(raw)) {
      lat = Number(raw[0] ?? 0); lon = Number(raw[1] ?? 0); radius = Number(raw[2] ?? 100)
    } else {
      const parts = String(raw).split(',').map(s => s.trim())
      lat = Number(parts[0] ?? 0); lon = Number(parts[1] ?? 0); radius = Number(parts[2] ?? 100)
    }
    return { type: kind, op, value: { lat, lon, radius_m: radius } }
  }
  const num = Number(Array.isArray(raw) ? (raw[0] ?? 0) : raw)
  return { type: kind, op, value: num }
}

// Back-compat helper for any existing calls
export function conditionFromSelection(kind: ConditionKind, raw: string): Condition {
  switch (kind) {
    case 'sport_type':
      return conditionFrom('sport_type', 'equals', raw)
    case 'distance':
      return conditionFrom('distance', 'gt', raw)
    case 'moving_time':
      return conditionFrom('moving_time', 'gt', raw)
    case 'total_elevation_gain':
      return conditionFrom('total_elevation_gain', 'gt', raw)
    case 'title':
      return conditionFrom('title', 'contains', raw)
    case 'day_of_week':
      return conditionFrom('day_of_week', 'in', raw)
  }
  switch (kind as string) {
    case 'distance_greater_than':
      return conditionFrom('distance', 'gt', raw)
    case 'moving_time_greater_than':
      return conditionFrom('moving_time', 'gt', raw)
    case 'elevation_gain_greater_than':
      return conditionFrom('total_elevation_gain', 'gt', raw)
    case 'title_contains':
      return conditionFrom('title', 'contains', raw)
  }
}

export function effectFromSelection(kind: EffectKind, raw: string): Effect {
  if (kind === 'set_title_suffix') return { type: 'set_title_suffix', params: { suffix: raw || '' } }
  if (kind === 'set_title_prefix') return { type: 'set_title_prefix', params: { prefix: raw || '' } }
  if (kind === 'set_commute') return { type: 'set_commute', params: { commute: true } }
  if (kind === 'set_sport_type') return { type: 'set_sport_type', params: { sport_type: raw || 'Run' } }
  if (kind === 'set_long_run_tag') return { type: 'set_long_run_tag' }
  if (kind === 'set_shoes_by_id') return { type: 'set_shoes_by_id', params: { gear_id: raw } }
  if (kind === 'set_title_template') return { type: 'set_title_template', params: { template: raw || 'Commute #{count:commute}' } }
  if (kind === 'hide_from_feeds') return { type: 'hide_from_feeds', params: { home: true, clubs: true } }
  if (kind === 'set_description') return { type: 'set_description', params: { text: raw || '' } }
  throw new Error(`Unknown effect kind: ${kind}`)
}

// ---------------- Helpers ----------------
/** Parse durations like "mm:ss", "h:mm:ss", optionally like "5m30s" or with "/km" suffix, to total seconds. */
export function parseDurationSeconds(text: string): number | null {
  if (!text) return null
  let s = text.trim().toLowerCase()
  s = s.replace('/km', '').replace('perkm', '').replace('per km', '').trim()
  if (/^\d{1,2}:\d{1,2}:\d{1,2}$/.test(s)) {
    const [h, m, sec] = s.split(':').map((x) => parseInt(x, 10))
    return h * 3600 + m * 60 + sec
  }
  if (/^\d{1,2}:\d{1,2}$/.test(s)) {
    const [m, sec] = s.split(':').map((x) => parseInt(x, 10))
    return m * 60 + sec
  }
  // 5m30s, 45s, 1h2m
  if (/\d+[hms]/.test(s)) {
    let total = 0
    const re = /(\d+)(h|m|s)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      const val = parseInt(m[1], 10)
      const u = m[2]
      if (u === 'h') total += val * 3600
      else if (u === 'm') total += val * 60
      else if (u === 's') total += val
    }
    if (total > 0) return total
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
