import type { Condition, Effect, Activity } from './api'

export function evaluateConditions(conditions: Condition[], activity: Activity): boolean {
  // Supports types: sport_type, distance, moving_time, total_elevation_gain, title
  return conditions.every((c) => {
    const op = (c as any).op as string
    const type = c.type
    const val = (c as any).value
    switch (type) {
      case 'sport_type':
        return op === 'equals' ? (activity.sport_type || '') === String(val) : true
      case 'distance':
        return compareNum(activity.distance, op, val)
      case 'moving_time':
        return compareNum(activity.moving_time, op, val)
      case 'moving_pace': {
        // seconds per km = moving_time / (distance_m / 1000)
        const mt = Number(activity.moving_time ?? 0)
        const dist = Number(activity.distance ?? 0)
        if (!isFinite(mt) || !isFinite(dist) || dist <= 0) return false
        const pace = mt / (dist / 1000)
        return compareNum(pace, op, val)
      }
      case 'total_elevation_gain':
        return compareNum(activity.total_elevation_gain, op, val)
      case 'title':
        return op === 'contains' ? (activity.name || '').toLowerCase().includes(String(val).toLowerCase()) : true
      case 'day_of_week': {
        // Determine local weekday from start_date_local if available, else start_date
        const src = activity.start_date_local || activity.start_date
        if (!src) return false
        const d = new Date(src)
        if (isNaN(d.getTime())) return false
        // JavaScript: 0=Sunday..6=Saturday. We'll accept names or numbers, normalize to Mon..Sun names
        const jsDay = d.getDay() // 0..6
        const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
        const dayName = names[jsDay]
        const arr = Array.isArray(val) ? val : [val]
        const normalized = arr.map((x: any) => String(x)).map((s: string) => s.trim())
        const match = normalized.some((s: string) => {
          if (s === '') return false
          if (/^\d+$/.test(s)) {
            // numeric: 0=Mon..6=Sun per backend; map to JS weekday names
            const n = parseInt(s, 10)
            const pyToJs = [1,2,3,4,5,6,0] // Mon..Sun -> JS (0=Sun)
            const target = names[pyToJs[(n % 7 + 7) % 7] as number]
            return target === dayName
          } else {
            return dayName.toLowerCase().startsWith(s.toLowerCase())
          }
        })
        return op === 'in' ? match : !match
      }
      default:
        // Unknown condition types: treat as non-blocking for preview
        return true
    }
  })
}

function compareNum(actual: number | null | undefined, op: string, target: unknown): boolean {
  const a = Number(actual ?? 0)
  const t = Number(target as any)
  if (Number.isNaN(t)) return false
  switch (op) {
    case 'gt':
      return a > t
    case 'ge':
      return a >= t
    case 'lt':
      return a < t
    case 'le':
      return a <= t
    case 'eq':
      return a === t
    default:
      return false
  }
}

export type EffectPreview = {
  name?: string | null
  sport_type?: string | null
  commute?: boolean | null
  gear_id?: string | null
  description?: string | null
  hide_from_home?: boolean | null
  tags?: string[]
}

export function previewEffects(effects: Effect[], activity: Activity): EffectPreview {
  let name = activity.name ?? ''
  let sport_type = activity.sport_type ?? null
  let commute: boolean | null = null
  let gear_id: string | null = (activity as any).gear_id ?? null
  let description: string | null = (activity as any).description ?? null
  let hide_from_home: boolean | null = null
  const tagSet = new Set<string>()
  for (const e of effects) {
    switch (e.type) {
      case 'set_title_suffix': {
        const suffix = (e as any).params?.suffix ?? ''
        name = `${name}${suffix}`
        break
      }
      case 'set_title_prefix': {
        const prefix = (e as any).params?.prefix ?? ''
        name = `${prefix}${name}`
        break
      }
      case 'set_commute': {
        const c = (e as any).params?.commute
        commute = Boolean(c ?? true)
        if (commute) tagSet.add('Commute')
        break
      }
      case 'set_sport_type': {
        const st = (e as any).params?.sport_type
        sport_type = String(st || sport_type || '')
        break
      }
      case 'set_title_template': {
        const tpl = (e as any).params?.template
        // Client preview cannot increment server-side counters; show template as-is
        name = String(tpl || name)
        break
      }
      case 'set_shoes_by_id': {
        const gid = (e as any).params?.gear_id
        gear_id = gid ? String(gid) : gear_id
        break
      }
      case 'set_long_run_tag': {
        tagSet.add('Long run')
        break
      }
      case 'hide_from_feeds': {
        const params = (e as any).params ?? {}
        const home = params.home ?? true
        hide_from_home = Boolean(home)
        if (hide_from_home) tagSet.add('Hidden from feeds')
        break
      }
      case 'set_description': {
        const text = (e as any).params?.text
        description = text != null ? String(text) : ''
        break
      }
    }
  }
  return {
    name,
    sport_type,
    commute,
    gear_id,
    description,
    hide_from_home,
    tags: Array.from(tagSet),
  }
}
