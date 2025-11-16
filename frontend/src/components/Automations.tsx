import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createAutomation, deleteAutomation, getAutomations, setAutomationEnabled, updateAutomation, getAthleteGear, geocode, type Activity, type Automation, type AutomationCreate, type Condition as CondType, type Effect as EffType, type GearItem } from '../lib/api'
import { useMemo, useState } from 'react'
import { CONDITION_SPECS, conditionFrom, effectFromSelection, type ConditionKind, type ConditionOp, type EffectKind } from '../lib/builder'
import { evaluateConditions, previewEffects } from '../lib/eval'

const CONDITION_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(CONDITION_SPECS).map(([k, spec]) => [k, spec.label])
)

const EFFECT_LABELS: Record<string, string> = {
  set_title_suffix: 'Set title suffix',
  set_title_prefix: 'Set title prefix',
  set_title_template: 'Set title template',
  set_commute: 'Mark as commute',
  set_sport_type: 'Set sport type',
  set_long_run_tag: 'Mark as long run',
  set_shoes_by_id: 'Set shoes by ID',
  hide_from_feeds: 'Hide from feeds',
  set_description: 'Set description',
}

function JsonTextarea({ value, onChange, rows = 4 }: { value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}
      placeholder="[]"
    />
  )
}

export function Automations() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['automations'], queryFn: getAutomations })

  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [priority, setPriority] = useState(0)
  const [conditions, setConditions] = useState('[]')
  const [effects, setEffects] = useState('[]')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [useBuilder, setUseBuilder] = useState(true)

  // Builder state
  const [builtConds, setBuiltConds] = useState<CondType[]>([])
  const [builtEffs, setBuiltEffs] = useState<EffType[]>([])

  const saveMut = useMutation({
    mutationFn: async () => {
      setError(null)
      let parsedConditions: unknown
      let parsedEffects: unknown
      if (useBuilder && (builtConds.length > 0 || builtEffs.length > 0)) {
        parsedConditions = builtConds
        parsedEffects = builtEffs
      } else {
        try {
          parsedConditions = conditions.trim() ? JSON.parse(conditions) : []
          parsedEffects = effects.trim() ? JSON.parse(effects) : []
          if (!Array.isArray(parsedConditions) || !Array.isArray(parsedEffects)) {
            throw new Error('conditions/effects must be arrays')
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Unknown error'
          throw new Error(`Invalid JSON: ${message}`)
        }
      }
      const payload: AutomationCreate = {
        name: name.trim(),
        enabled,
        priority: Number.isFinite(priority) ? priority : 0,
        conditions: parsedConditions as CondType[],
        effects: parsedEffects as EffType[],
      }
      if (!payload.name) throw new Error('Name is required')
      if (editingId) return updateAutomation(editingId, payload)
      return createAutomation(payload)
    },
    onSuccess: () => {
      setName('')
      setEnabled(true)
      setPriority(0)
      setConditions('[]')
      setEffects('[]')
      setBuiltConds([])
      setBuiltEffs([])
      setEditingId(null)
      qc.invalidateQueries({ queryKey: ['automations'] })
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Save failed'),
  })

  const delMut = useMutation({
    mutationFn: (id: string) => deleteAutomation(id),
    onSuccess: (_data, id) => {
      // Optimistically update cache for snappy UI, also invalidate to stay correct
      qc.setQueryData<Automation[] | undefined>(['automations'], (old) => Array.isArray(old) ? old.filter((a) => a.id !== id) : old)
      qc.invalidateQueries({ queryKey: ['automations'] })
    },
  })

  const { startEdit, cancelEdit } = useEditHelpers([
    setEditingId,
    setName,
    setEnabled,
    setPriority,
    setBuiltConds,
    setBuiltEffs,
    setUseBuilder,
    setConditions,
    setEffects,
  ])

  return (
    <div>
      <h3 style={{ marginTop: 24 }}>Automations</h3>
      {list.isLoading && <div>Loading…</div>}
      {list.isError && <div>Failed to load automations</div>}
      {!list.isLoading && !list.isError && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
          <thead>
            <tr>
              <th align="left">Name</th>
              <th align="left">Enabled</th>
              <th align="right">Priority</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data!.map((a) => (
              <tr key={a.id}>
                <td style={{ borderTop: '1px solid #eee' }}>{a.name}</td>
                <td style={{ borderTop: '1px solid #eee' }}>
                  <EnabledToggle enabled={a.enabled} onChange={async (next) => {
                    await setAutomationEnabled(a.id, next)
                    qc.invalidateQueries({ queryKey: ['automations'] })
                  }} />
                </td>
                <td style={{ borderTop: '1px solid #eee', textAlign: 'right' }}>{a.priority}</td>
                <td style={{ borderTop: '1px solid #eee', textAlign: 'right' }}>
                  <button onClick={() => startEdit(a)} style={{ marginRight: 8 }}>Edit</button>
                  <button onClick={() => delMut.mutate(a.id)} disabled={delMut.isPending}>Delete</button>
                </td>
              </tr>
            ))}
            {list.data!.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: 'var(--muted)', paddingTop: 8 }}>No automations yet</td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
        <h4 style={{ marginTop: 0 }}>{editingId ? 'Edit Automation' : 'New Automation'}</h4>
        {error && <div style={{ color: 'crimson', marginBottom: 8 }}>{error}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px 200px', gap: 8, alignItems: 'center' }}>
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
            <span style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'inherit' }}>Priority (higher runs first)</span>
            <input type="number" value={priority} onChange={(e) => setPriority(parseInt(e.target.value || '0', 10))} style={{ width: 80 }} />
          </label>
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={useBuilder} onChange={(e) => setUseBuilder(e.target.checked)} /> Use builder (recommended)
          </label>
        </div>

        {useBuilder ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            <BuilderConditions value={builtConds} onChange={setBuiltConds} />
            <BuilderEffects value={builtEffs} onChange={setBuiltEffs} />
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Conditions (JSON array)</div>
              <JsonTextarea value={conditions} onChange={setConditions} rows={6} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Effects (JSON array)</div>
              <JsonTextarea value={effects} onChange={setEffects} rows={6} />
            </div>
          </div>
        )}
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>{editingId ? 'Save' : 'Create'}</button>
          {editingId && (
            <button onClick={cancelEdit} type="button">Cancel</button>
          )}
        </div>
        <PreviewPanel conditions={useBuilder ? builtConds : safeParseArray<CondType>(conditions)} effects={useBuilder ? builtEffs : safeParseArray<EffType>(effects)} />
      </div>
    </div>
  )
}

export default Automations

// ----------------------------- Builder components ---------------------------

function DayMultiSelect({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  function toggle(day: string) {
    const has = value.includes(day)
    onChange(has ? value.filter((d) => d !== day) : [...value, day])
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {days.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => toggle(d)}
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            border: value.includes(d) ? '1px solid #0b5cab' : '1px solid #ccc',
            background: value.includes(d) ? 'var(--tag-bg)' : 'var(--surface)',
            color: value.includes(d) ? 'var(--tag-fg)' : 'var(--fg)',
            fontSize: 12,
            }}
        >
          {d}
        </button>
      ))}
    </div>
  )
}

function ShoesSelect({ onSelect }: { onSelect: (gear_id: string) => void }) {
  const q = useQuery({ queryKey: ['athlete-gear'], queryFn: getAthleteGear })
  if (q.isLoading) return <span>Loading shoes…</span>
  if (q.isError) return <span style={{ color: 'crimson' }}>Failed to load shoes</span>
  const shoes: GearItem[] = q.data?.shoes ?? []
  return (
    <select onChange={(e) => onSelect(e.target.value)} defaultValue="">
      <option value="" disabled>Select shoes…</option>
      {shoes.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}{s.primary ? ' (primary)' : ''}
        </option>
      ))}
    </select>
  )
}

function BuilderConditions({ value, onChange }: { value: CondType[]; onChange: (v: CondType[]) => void }) {
  const [type, setType] = useState<ConditionKind>('sport_type')
  const [op, setOp] = useState<ConditionOp>(CONDITION_SPECS['sport_type'].ops[0])
  const [val, setVal] = useState('')
  const [selectedDays, setSelectedDays] = useState<string[]>([])
  const [addr, setAddr] = useState('')
  const [addrOpts, setAddrOpts] = useState<{ lat: number; lon: number; display_name: string }[]>([])
  const [selLat, setSelLat] = useState<number | null>(null)
  const [selLon, setSelLon] = useState<number | null>(null)
  const [radius, setRadius] = useState<string>('100')

  function add() {
    const conds = [...value]
    if (type === 'day_of_week') {
      if (selectedDays.length === 0) return
      conds.push(conditionFrom(type, op, selectedDays))
      setSelectedDays([])
    } else if (type === 'start_near' || type === 'end_near') {
      // Prefer structured state; fall back to parsing val if needed
      const r = Number(radius || '100')
      if (selLat != null && selLon != null) {
        conds.push(conditionFrom(type, op, [selLat, selLon, r]))
        // reset
        setAddr(''); setAddrOpts([]); setSelLat(null); setSelLon(null); setRadius('100'); setVal('')
      } else if (val.trim()) {
        conds.push(conditionFrom(type, op, val))
        setVal('')
      } else {
        return
      }
    } else {
      if (!val.trim()) return
      conds.push(conditionFrom(type, op, val))
      setVal('')
    }
    onChange(conds)
  }

  function remove(i: number) {
    const copy = value.slice(); copy.splice(i, 1); onChange(copy)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <select
          value={type}
          onChange={(e) => {
            const t = e.target.value as ConditionKind
            setType(t)
            setOp(CONDITION_SPECS[t].ops[0])
            if (t !== 'start_near' && t !== 'end_near') {
              setAddr(''); setAddrOpts([]); setSelLat(null); setSelLon(null); setRadius('100')
            }
          }}
        >
          {Object.entries(CONDITION_SPECS).map(([k, spec]) => (
            <option key={k} value={k}>{spec.label}</option>
          ))}
        </select>
        {CONDITION_SPECS[type].ops.length > 1 && (
          <select value={op} onChange={(e) => setOp(e.target.value as ConditionOp)}>
            {CONDITION_SPECS[type].ops.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        )}
        {type !== 'day_of_week' && type !== 'start_near' && type !== 'end_near' && (
          <input
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={CONDITION_SPECS[type].placeholder || 'value'}
          />
        )}
        {(type === 'start_near' || type === 'end_near') && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, minWidth: 280, flex: '1 1 320px' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder={'Search address (OSM)'}
                style={{ flex: '1 1 240px' }}
              />
              <button
                onClick={async () => {
                  try {
                    const res = await geocode(addr)
                    setAddrOpts(res.items)
                    if (res.items.length === 1) {
                      const o = res.items[0]
                      setSelLat(o.lat); setSelLon(o.lon)
                      const r = radius || '100'
                      setVal(`${o.lat},${o.lon},${r}`)
                    }
                  } catch {
                    setAddrOpts([])
                  }
                }}
              >Lookup</button>
            </div>
            {addrOpts.length > 0 && (
              <select
                onChange={(e) => {
                  const i = parseInt(e.target.value, 10)
                  const opt = addrOpts[i]
                  if (!opt) return
                  // keep previous radius part if set
                  const parts = (val || '').split(',').map(s => s.trim())
                  const r = parts.length >= 3 ? parts[2] : '100'
                  setSelLat(opt.lat); setSelLon(opt.lon)
                  setVal(`${opt.lat},${opt.lon},${r}`)
                }}
                defaultValue="-1"
              >
                <option value="-1" disabled>Pick result…</option>
                {addrOpts.map((o, i) => (
                  <option key={i} value={i}>{o.display_name}</option>
                ))}
              </select>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'var(--muted)' }}>Radius (m)</label>
              <input
                type="number"
                min={1}
                value={radius}
                onChange={(e) => {
                  const r = e.target.value || '100'
                  setRadius(r)
                  if (selLat != null && selLon != null) {
                    setVal(`${selLat},${selLon},${r}`)
                  } else {
                    const parts = (val || '').split(',').map(s => s.trim())
                    if (parts.length >= 2) setVal(`${parts[0]},${parts[1]},${r}`)
                  }
                }}
                style={{ width: 120 }}
              />
            </div>
          </div>
        )}
        {type === 'day_of_week' && (
          <DayMultiSelect value={selectedDays} onChange={setSelectedDays} />
        )}
        <button onClick={add}>Add</button>
      </div>
      {value.length > 0 && (
        <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: 'var(--surface-strong, #f5f5f5)' }}>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Condition</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Operator</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Value</th>
                <th style={{ width: 70 }}></th>
              </tr>
            </thead>
            <tbody>
              {value.map((c, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px' }}>{describeConditionType(c)}</td>
                  <td style={{ padding: '6px 8px' }}>{c.op || '—'}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{formatConditionValue(c)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    <button onClick={() => remove(i)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function BuilderEffects({ value, onChange }: { value: EffType[]; onChange: (v: EffType[]) => void }) {
  const [type, setType] = useState<EffectKind>('set_title_suffix')
  const [val, setVal] = useState('')

  function add() {
    const effs = [...value]
    effs.push(effectFromSelection(type, val))
    onChange(effs)
    setVal('')
  }

  function remove(i: number) {
    const copy = value.slice(); copy.splice(i, 1); onChange(copy)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <select value={type} onChange={(e) => setType(e.target.value as EffectKind)}>
          <option value="set_title_suffix">Set title suffix</option>
          <option value="set_title_prefix">Set title prefix</option>
          <option value="set_commute">Mark as commute</option>
          <option value="set_sport_type">Set sport type</option>
          <option value="set_long_run_tag">Mark as long run (Run only)</option>
          <option value="set_shoes_by_id">Set shoes by ID</option>
          <option value="set_title_template">Set title from template</option>
          <option value="hide_from_feeds">Hide from feeds</option>
          <option value="set_description">Set description</option>
        </select>
        {(type === 'set_title_suffix' || type === 'set_sport_type') && (
          <input value={val} onChange={(e) => setVal(e.target.value)} placeholder={type === 'set_title_suffix' ? 'e.g. 🚀' : 'e.g. Ride'} />
        )}
        {type === 'set_title_template' && (
          <input value={val} onChange={(e) => setVal(e.target.value)} placeholder={'e.g. Commute #{count:commute}'} />
        )}
        {type === 'set_description' && (
          <input value={val} onChange={(e) => setVal(e.target.value)} placeholder={'Description text'} />
        )}
        {type === 'set_shoes_by_id' && (
          <ShoesSelect onSelect={(gid) => setVal(gid)} />
        )}
        <button onClick={add}>Add</button>
      </div>
      {value.length > 0 && (
        <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: 'var(--surface-strong, #f5f5f5)' }}>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Effect</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Details</th>
                <th style={{ width: 70 }}></th>
              </tr>
            </thead>
            <tbody>
              {value.map((e, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px' }}>{describeEffectType(e)}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{formatEffectValue(e)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    <button onClick={() => remove(i)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function EnabledToggle({ enabled, onChange }: { enabled: boolean; onChange: (next: boolean) => void | Promise<void> }) {
  const [pending, setPending] = useState(false)
  return (
    <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <input
        type="checkbox"
        checked={enabled}
        onChange={async (e) => {
          setPending(true)
          try { await onChange(e.target.checked) } finally { setPending(false) }
        }}
        disabled={pending}
      />
      {enabled ? 'On' : 'Off'}
    </label>
  )
}

type SampleForm = {
  name: string
  sportType: string
  startDate: string
  startDateLocal: string
  distance: string
  movingTime: string
  elapsedTime: string
  totalElevation: string
  startLat: string
  startLng: string
  endLat: string
  endLng: string
  commute: boolean
  description: string
  gearId: string
}

type PreviewActivity = Activity & { start_lat?: number | null; start_lng?: number | null; end_lat?: number | null; end_lng?: number | null }

function PreviewPanel({ conditions, effects }: { conditions: CondType[]; effects: EffType[] }) {
  const [sample, setSample] = useState<SampleForm>({
    name: 'Morning Run',
    sportType: 'Run',
    startDate: '2024-01-01T10:00',
    startDateLocal: '2024-01-01T21:00',
    distance: '5000',
    movingTime: '1800',
    elapsedTime: '1900',
    totalElevation: '120',
    startLat: '',
    startLng: '',
    endLat: '',
    endLng: '',
    commute: false,
    description: '',
    gearId: '',
  })

  function updateSample<K extends keyof SampleForm>(key: K, value: SampleForm[K]) {
    setSample((prev) => ({ ...prev, [key]: value }))
  }

  const activity = useMemo(() => {
    const toIso = (val: string) => {
      if (!val) return null
      const dt = new Date(val)
      if (Number.isNaN(dt.getTime())) return val
      return dt.toISOString()
    }
    const parseNum = (val: string) => {
      if (!val) return null
      const n = Number(val)
      return Number.isFinite(n) ? n : null
    }
    const base: PreviewActivity = {
      id: 1,
      name: sample.name || '',
      sport_type: sample.sportType || null,
      start_date: sample.startDate ? toIso(sample.startDate) : null,
      start_date_local: sample.startDateLocal ? toIso(sample.startDateLocal) : null,
      distance: parseNum(sample.distance),
      moving_time: parseNum(sample.movingTime),
      elapsed_time: parseNum(sample.elapsedTime),
      total_elevation_gain: parseNum(sample.totalElevation),
      commute: sample.commute,
      description: sample.description || null,
      gear_id: sample.gearId || null,
    }
    const startLat = parseNum(sample.startLat)
    const startLng = parseNum(sample.startLng)
    const endLat = parseNum(sample.endLat)
    const endLng = parseNum(sample.endLng)
    if (startLat !== null) base.start_lat = startLat
    if (startLng !== null) base.start_lng = startLng
    if (endLat !== null) base.end_lat = endLat
    if (endLng !== null) base.end_lng = endLng
    return base
  }, [sample])

  const applies = evaluateConditions(conditions, activity)
  const preview = applies ? previewEffects(effects, activity) : null

  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ marginBottom: 8 }}>Preview</h4>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Sample activity</div>
          <div style={{ display: 'grid', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Title</span>
              <input value={sample.name} onChange={(e) => updateSample('name', e.target.value)} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Sport type</span>
              <select value={sample.sportType} onChange={(e) => updateSample('sportType', e.target.value)}>
                {['Run', 'Ride', 'Walk', 'Hike', 'Swim', 'Workout'].map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
                <option value="">(none)</option>
              </select>
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Start date (UTC)</span>
                <input type="datetime-local" value={sample.startDate} onChange={(e) => updateSample('startDate', e.target.value)} />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Start date (local)</span>
                <input type="datetime-local" value={sample.startDateLocal} onChange={(e) => updateSample('startDateLocal', e.target.value)} />
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Distance (m)</span>
                <input type="number" value={sample.distance} onChange={(e) => updateSample('distance', e.target.value)} />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Moving time (s)</span>
                <input type="number" value={sample.movingTime} onChange={(e) => updateSample('movingTime', e.target.value)} />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Elapsed time (s)</span>
                <input type="number" value={sample.elapsedTime} onChange={(e) => updateSample('elapsedTime', e.target.value)} />
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Elevation gain (m)</span>
                <input type="number" value={sample.totalElevation} onChange={(e) => updateSample('totalElevation', e.target.value)} />
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 16 }}>
                <input type="checkbox" checked={sample.commute} onChange={(e) => updateSample('commute', e.target.checked)} /> Commute
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Start lat</span>
                <input type="number" step="any" value={sample.startLat} onChange={(e) => updateSample('startLat', e.target.value)} />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Start lon</span>
                <input type="number" step="any" value={sample.startLng} onChange={(e) => updateSample('startLng', e.target.value)} />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>End lat</span>
                <input type="number" step="any" value={sample.endLat} onChange={(e) => updateSample('endLat', e.target.value)} />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>End lon</span>
                <input type="number" step="any" value={sample.endLng} onChange={(e) => updateSample('endLng', e.target.value)} />
              </label>
            </div>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Description</span>
              <textarea rows={3} value={sample.description} onChange={(e) => updateSample('description', e.target.value)} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Gear ID</span>
              <input value={sample.gearId} onChange={(e) => updateSample('gearId', e.target.value)} placeholder="e.g. gear_123" />
            </label>
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Result</div>
          <div>
            Would apply: <strong>{applies ? 'Yes' : 'No'}</strong>
          </div>
          {applies && preview && (
            <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
              {preview.tags && preview.tags.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {preview.tags.map((tag) => (
                    <PreviewTag key={tag}>{tag}</PreviewTag>
                  ))}
                </div>
              )}
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {preview.name !== undefined && (
                  <li>Title → <code>{String(preview.name ?? '')}</code></li>
                )}
                {preview.sport_type !== undefined && (
                  <li>Sport type → <code>{String(preview.sport_type ?? '')}</code></li>
                )}
                {preview.commute !== null && preview.commute !== undefined && (
                  <li>Commute → <code>{preview.commute ? 'Yes' : 'No'}</code></li>
                )}
                {preview.gear_id !== undefined && preview.gear_id !== null && (
                  <li>Shoes/Gear → <code>{String(preview.gear_id)}</code></li>
                )}
                {preview.description !== undefined && preview.description !== null && (
                  <li>Description → <code>{String(preview.description)}</code></li>
                )}
                {preview.hide_from_home !== undefined && preview.hide_from_home !== null && (
                  <li>Hide from home feed → <code>{preview.hide_from_home ? 'Yes' : 'No'}</code></li>
                )}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PreviewTag({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        background: 'var(--tag-bg)',
        color: 'var(--tag-fg)',
        border: '1px solid var(--tag-border)',
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 11,
      }}
    >
      {children}
    </span>
  )
}

function describeConditionType(c: CondType): string {
  return CONDITION_LABELS[c.type as string] ?? c.type
}

function formatConditionValue(c: CondType): string {
  const value = c.value
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    return '—'
  }
  if (Array.isArray(value)) {
    return value.join(', ')
  }
  if (typeof value === 'object' && value !== null) {
    const maybe = value as { lat?: unknown; lon?: unknown; radius_m?: unknown; radius?: unknown }
    if (typeof maybe.lat === 'number' && typeof maybe.lon === 'number') {
      const radius = typeof maybe.radius_m === 'number' ? maybe.radius_m : typeof maybe.radius === 'number' ? maybe.radius : null
      const lat = Number.isFinite(maybe.lat) ? maybe.lat.toFixed(4) : String(maybe.lat)
      const lon = Number.isFinite(maybe.lon) ? maybe.lon.toFixed(4) : String(maybe.lon)
      const radiusText = radius != null && Number.isFinite(radius) ? `${radius}m` : '?'
      return `${lat}, ${lon} (±${radiusText})`
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  return String(value)
}

function describeEffectType(e: EffType): string {
  return EFFECT_LABELS[e.type as string] ?? e.type
}

function formatEffectValue(e: EffType): string {
  const params = (e.params ?? {}) as Record<string, unknown>
  const stringParam = (key: string) => {
    const val = params[key]
    return typeof val === 'string' ? val : ''
  }
  const booleanParam = (key: string, fallback: boolean) => {
    const val = params[key]
    return typeof val === 'boolean' ? val : fallback
  }
  switch (e.type) {
    case 'set_title_suffix':
      return stringParam('suffix') ? `suffix: ${stringParam('suffix')}` : 'suffix: (empty)'
    case 'set_title_prefix':
      return stringParam('prefix') ? `prefix: ${stringParam('prefix')}` : 'prefix: (empty)'
    case 'set_title_template':
      return stringParam('template') ? `template: ${stringParam('template')}` : 'template: (empty)'
    case 'set_sport_type':
      return stringParam('sport_type') ? `sport_type: ${stringParam('sport_type')}` : 'sport_type: (empty)'
    case 'set_commute':
      return `commute: ${booleanParam('commute', true)}`
    case 'set_shoes_by_id':
      return stringParam('gear_id') ? `gear_id: ${stringParam('gear_id')}` : 'gear_id: (empty)'
    case 'hide_from_feeds':
      return `home: ${booleanParam('home', true)}, clubs: ${booleanParam('clubs', true)}`
    case 'set_description':
      return stringParam('text') ? `description: ${stringParam('text')}` : 'description: (empty)'
    case 'set_long_run_tag':
      return 'Adds Long run tag'
    default:
      return Object.keys(params).length ? JSON.stringify(params) : '—'
  }
}

function safeParseArray<T>(text: string): T[] {
  try {
    const v = text.trim() ? JSON.parse(text) : []
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
function startEditFactory(
  setEditingId: (v: string | null) => void,
  setName: (v: string) => void,
  setEnabled: (v: boolean) => void,
  setPriority: (v: number) => void,
  setBuiltConds: (v: CondType[]) => void,
  setBuiltEffs: (v: EffType[]) => void,
  setUseBuilder: (v: boolean) => void,
  setConditions: (v: string) => void,
  setEffects: (v: string) => void,
) {
  return (a: Automation) => {
    setEditingId(a.id)
    setName(a.name)
    setEnabled(a.enabled)
    setPriority(a.priority)
    try {
      setBuiltConds(a.conditions as CondType[])
      setBuiltEffs(a.effects as EffType[])
      setUseBuilder(true)
    } catch {
      setUseBuilder(false)
      setConditions(JSON.stringify(a.conditions))
      setEffects(JSON.stringify(a.effects))
    }
  }
}

function useEditHelpers(
  setters: Parameters<typeof startEditFactory>
) {
  const startEdit = startEditFactory(...setters)
  function cancelEdit() {
    const [setEditingId, setName, setEnabled, setPriority, , , setUseBuilder, setConditions, setEffects] = setters
    setEditingId(null)
    setName('')
    setEnabled(true)
    setPriority(0)
    setUseBuilder(true)
    setConditions('[]')
    setEffects('[]')
  }
  return { startEdit, cancelEdit }
}
