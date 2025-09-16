import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createAutomation, deleteAutomation, getAutomations, setAutomationEnabled, updateAutomation, type Automation, type AutomationCreate, type Condition as CondType, type Effect as EffType } from '../lib/api'
import { useMemo, useState } from 'react'
import { CONDITION_SPECS, conditionFrom, conditionFromSelection, effectFromSelection, type ConditionKind, type ConditionOp, type EffectKind } from '../lib/builder'
import { evaluateConditions, previewEffects } from '../lib/eval'

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

  const builtCondsJson = useMemo(() => JSON.stringify(builtConds, null, 2), [builtConds])
  const builtEffsJson = useMemo(() => JSON.stringify(builtEffs, null, 2), [builtEffs])

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
        } catch (e: any) {
          throw new Error(`Invalid JSON: ${e.message}`)
        }
      }
      const payload: AutomationCreate = {
        name: name.trim(),
        enabled,
        priority: Number.isFinite(priority) ? priority : 0,
        conditions: parsedConditions as any[],
        effects: parsedEffects as any[],
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
    onError: (e: any) => setError(e?.message || 'Save failed'),
  })

  const delMut = useMutation({
    mutationFn: (id: string) => deleteAutomation(id),
    onSuccess: (_data, id) => {
      // Optimistically update cache for snappy UI, also invalidate to stay correct
      qc.setQueryData(['automations'], (old: any) => Array.isArray(old) ? old.filter((a) => a.id !== id) : old)
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
                  <EnabledToggle id={a.id} enabled={a.enabled} onChange={async (next) => {
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
        <AutomationHelp />
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

import { getAthleteGear, geocode } from '../lib/api'
function ShoesSelect({ onSelect }: { onSelect: (gear_id: string) => void }) {
  const q = useQuery({ queryKey: ['athlete-gear'], queryFn: getAthleteGear })
  if (q.isLoading) return <span>Loading shoes…</span>
  if (q.isError) return <span style={{ color: 'crimson' }}>Failed to load shoes</span>
  const shoes = q.data?.shoes || []
  return (
    <select onChange={(e) => onSelect(e.target.value)} defaultValue="">
      <option value="" disabled>Select shoes…</option>
      {shoes.map((s: any) => (
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
        <select value={op} onChange={(e) => setOp(e.target.value as ConditionOp)}>
          {CONDITION_SPECS[type].ops.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
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
      <pre style={{ background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', padding: 8, maxHeight: 160, overflow: 'auto', borderRadius: 6 }}>{JSON.stringify(value, null, 2)}</pre>
      {value.length > 0 && (
        <ul>
          {value.map((c, i) => (
            <li key={i}>
              <code>{c.type}</code> <code>{(c as any).op}</code> <code>{String((c as any).value)}</code>
              <button onClick={() => remove(i)} style={{ marginLeft: 8 }}>Remove</button>
            </li>
          ))}
        </ul>
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
      <pre style={{ background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', padding: 8, maxHeight: 160, overflow: 'auto', borderRadius: 6 }}>{JSON.stringify(value, null, 2)}</pre>
      {value.length > 0 && (
        <ul>
          {value.map((e, i) => (
            <li key={i}>
              <code>{e.type}</code> {e.params && <code>{JSON.stringify(e.params)}</code>}
              <button onClick={() => remove(i)} style={{ marginLeft: 8 }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AutomationHelp() {
  return (
    <details style={{ marginTop: 12 }}>
      <summary>What JSON is valid?</summary>
      <div style={{ fontSize: 14 }}>
        <p>Conditions are objects with fields: <code>type</code>, <code>op</code>, <code>value</code>. Examples:</p>
        <pre>{`[
  { "type": "sport_type", "op": "equals", "value": "Run" },
  { "type": "distance", "op": "gt", "value": 5000 },
  { "type": "moving_time", "op": "gt", "value": 1800 },
  { "type": "total_elevation_gain", "op": "gt", "value": 300 },
  { "type": "title", "op": "contains", "value": "Commute" },
  { "type": "day_of_week", "op": "in", "value": ["Mon", "Wed", "Fri"] }
]`}</pre>
        <p>Effects are objects with fields: <code>type</code> and optional <code>params</code>. Examples:</p>
        <pre>{`[
  { "type": "set_title_suffix", "params": { "suffix": " 🚀" } },
  { "type": "set_title_prefix", "params": { "prefix": "[Ride] " } },
  { "type": "set_commute", "params": { "commute": true } },
  { "type": "set_sport_type", "params": { "sport_type": "Ride" } },
  { "type": "set_long_run_tag" }
]`}</pre>
        <p>These are MVP examples; backend currently stores JSON as-is. Future releases will validate and execute effects.</p>
      </div>
    </details>
  )
}

function EnabledToggle({ id, enabled, onChange }: { id: string; enabled: boolean; onChange: (next: boolean) => void | Promise<void> }) {
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

function PreviewPanel({ conditions, effects }: { conditions: CondType[]; effects: EffType[] }) {
  const [sample, setSample] = useState<string>(
    JSON.stringify(
      {
        id: 1,
        start_date: '2024-01-01T10:00:00Z',
        start_date_local: '2024-01-01T21:00:00+11:00',
        sport_type: 'Run',
        name: 'Morning Run',
        distance: 5000,
        moving_time: 1800,
        elapsed_time: 1900,
        total_elevation_gain: 120,
      },
      null,
      2,
    ),
  )
  let activity: any = null
  try {
    activity = JSON.parse(sample)
  } catch {
    activity = null
  }
  const applies = activity ? evaluateConditions(conditions, activity) : false
  const preview = activity && applies ? previewEffects(effects, activity) : null

  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ marginBottom: 8 }}>Preview</h4>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Sample activity JSON</div>
          <textarea
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            rows={10}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}
          />
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Result</div>
          {!activity && <div style={{ color: 'crimson' }}>Invalid JSON</div>}
          {activity && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
              <div>
                Would apply: <strong>{applies ? 'Yes' : 'No'}</strong>
              </div>
              {applies && preview && (
                <ul>
                  {'name' in preview && preview.name !== undefined && (
                    <li>
                      New title: <code>{String(preview.name)}</code>
                    </li>
                  )}
                  {'sport_type' in preview && preview.sport_type !== undefined && (
                    <li>
                      New sport type: <code>{String(preview.sport_type)}</code>
                    </li>
                  )}
                  {'commute' in preview && preview.commute !== null && (
                    <li>
                      Commute: <code>{String(preview.commute)}</code>
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
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
