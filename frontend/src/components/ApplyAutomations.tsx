import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { applyActivity, getActivities, previewActivity, getAutomations, type Automation, reverseGeocode, type Activity, type ActivityPreview } from '../lib/api'
import { formatDateTime, formatDistance, formatDuration } from '../lib/format'

const PAGE_SIZE = 10
type ActivityWithCoords = Activity & { start_lat?: number | null; start_lng?: number | null; end_lat?: number | null; end_lng?: number | null }

export function ApplyAutomations() {
  const qc = useQueryClient()
  const [offset, setOffset] = useState(0)
  const autos = useQuery({ queryKey: ['automations'], queryFn: getAutomations })
  const [selectedAutoId, setSelectedAutoId] = useState<string>('')
  const acts = useQuery({
    queryKey: ['apply-activities', PAGE_SIZE, offset],
    queryFn: () => getActivities(PAGE_SIZE, offset),
    keepPreviousData: true,
    refetchInterval: 30000,
  })
  const total = acts.data?.total ?? 0
  const items = acts.data?.items ?? []
  const canPrev = offset > 0
  const canNext = offset + PAGE_SIZE < total

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Apply Automations</h3>
        <span style={{ color: 'var(--muted)' }}>Total: {total}</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Automation</span>
          <select value={selectedAutoId} onChange={(e) => setSelectedAutoId(e.target.value)}>
            <option value=''>All</option>
            {autos.data?.map((a: Automation) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
        <div style={{ marginLeft: 'auto' }}>
          <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={!canPrev}>Prev</button>
          <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={!canNext} style={{ marginLeft: 8 }}>Next</button>
        </div>
      </div>
      {acts.isLoading && <div>Loading…</div>}
      {acts.isError && <div>Failed to load</div>}
      {!acts.isLoading && !acts.isError && (
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th align="left" style={{ width: '18%' }}>Date</th>
              <th align="left" style={{ width: '10%' }}>Sport</th>
              <th align="left" style={{ width: '32%' }}>Name</th>
              <th align="right" style={{ width: '10%' }}>Dist</th>
              <th align="right" style={{ width: '10%' }}>Move</th>
              <th align="left" style={{ width: '20%' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <Row
                key={a.id}
                activity={a as ActivityWithCoords}
                onChanged={() => qc.invalidateQueries({ queryKey: ['apply-activities'] })}
                selectedAutomationId={selectedAutoId || null}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function Row({ activity, onChanged, selectedAutomationId }: { activity: ActivityWithCoords; onChanged: () => void; selectedAutomationId: string | null }) {
  const [open, setOpen] = useState(false)
  const prev = useQuery<ActivityPreview>({
    queryKey: ['apply-preview', activity.id, open, selectedAutomationId],
    queryFn: () => previewActivity(activity.id),
    enabled: open || !!selectedAutomationId,
  })
  const [applying, setApplying] = useState(false)
  const applies = prev.data?.applies
  const matchedAutomations = prev.data?.matched_automations ?? []
  const matchesSelected = selectedAutomationId
    ? matchedAutomations.some((m) => m.id === selectedAutomationId)
    : true

  // When a specific automation is selected, hide rows that do not match/apply
  if (selectedAutomationId && (!prev.data || !matchesSelected)) return null

  return (
    <>
      <tr>
        <td style={{ borderTop: '1px solid var(--border)', padding: '4px 0' }}>{formatDateTime(activity.start_date_local || activity.start_date)}</td>
        <td style={{ borderTop: '1px solid var(--border)' }}>{activity.sport_type || ''}</td>
        <td style={{ borderTop: '1px solid var(--border)', overflowWrap: 'anywhere' }}>{activity.name || ''}</td>
        <td style={{ borderTop: '1px solid var(--border)', textAlign: 'right' }}>{formatDistance(activity.distance)}</td>
        <td style={{ borderTop: '1px solid var(--border)', textAlign: 'right' }}>{formatDuration(activity.moving_time)}</td>
        <td style={{ borderTop: '1px solid var(--border)' }}>
          <button onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Preview'}</button>
          <button
            onClick={async () => {
              setApplying(true)
              try {
                const res = await applyActivity(activity.id)
                if (res.updated) onChanged()
              } finally {
                setApplying(false)
              }
            }}
            disabled={!applies || applying}
            style={{ marginLeft: 8 }}
            title={applies ? 'Apply matching automations' : 'No matching automations'}
          >{applying ? 'Applying…' : 'Apply'}</button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>
            {prev.isLoading && <div>Calculating…</div>}
            {prev.isError && <div>Failed to preview</div>}
            {prev.data && (
              <div style={{ display: 'flex', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>Would apply</div>
                  <div><strong>{prev.data.applies ? 'Yes' : 'No'}</strong></div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Matched automations</div>
                  {prev.data.matched_automations.length === 0 ? (
                    <div style={{ color: 'var(--muted-weak)' }}>None</div>
                  ) : (
                    <ul>
                      {prev.data.matched_automations.map((m) => (
                        <li key={m.id}><code>{m.name}</code></li>
                      ))}
                    </ul>
                  )}
                  <ActivityCoords activity={activity} />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>Desired changes</div>
                  <ul>
                    {'name' in prev.data.desired && (
                      <li>Title: <code>{String(prev.data.desired.name ?? '')}</code></li>
                    )}
                    {'description' in prev.data.desired && prev.data.desired.description !== undefined && (
                      <li>Description: <code>{String(prev.data.desired.description ?? '')}</code></li>
                    )}
                    {'sport_type' in prev.data.desired && (
                      <li>Sport: <code>{String(prev.data.desired.sport_type ?? '')}</code></li>
                    )}
                    {'commute' in prev.data.desired && prev.data.desired.commute !== undefined && (
                      <li>Commute: <code>{String(prev.data.desired.commute)}</code></li>
                    )}
                    {'workout_type' in prev.data.desired && prev.data.desired.workout_type !== undefined && (
                      <li>Workout type: <code>{String(prev.data.desired.workout_type)}</code></li>
                    )}
                    {'hide_from_home' in prev.data.desired && prev.data.desired.hide_from_home !== undefined && (
                      <li>Hide from feeds: <code>{String(prev.data.desired.hide_from_home)}</code></li>
                    )}
                  </ul>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

export default ApplyAutomations

function ActivityCoords({ activity }: { activity: ActivityWithCoords }) {
  const hasStart = Number.isFinite(activity.start_lat) && Number.isFinite(activity.start_lng)
  const hasEnd = Number.isFinite(activity.end_lat) && Number.isFinite(activity.end_lng)
  const startRQ = useQuery({
    queryKey: ['revgeo', 'start', activity.id, activity.start_lat, activity.start_lng],
    queryFn: () => reverseGeocode(activity.start_lat, activity.start_lng),
    enabled: hasStart,
  })
  const endRQ = useQuery({
    queryKey: ['revgeo', 'end', activity.id, activity.end_lat, activity.end_lng],
    queryFn: () => reverseGeocode(activity.end_lat, activity.end_lng),
    enabled: hasEnd,
  })
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Activity location</div>
      <ul style={{ marginTop: 4 }}>
        <li>
          Start: <code>{activity.start_lat ?? '—'}</code>, <code>{activity.start_lng ?? '—'}</code>
          {hasStart && (
            <span> — <span style={{ color: 'var(--muted)' }}>{startRQ.data?.display_name || (startRQ.isLoading ? 'resolving…' : '')}</span></span>
          )}
        </li>
        <li>
          End: <code>{activity.end_lat ?? '—'}</code>, <code>{activity.end_lng ?? '—'}</code>
          {hasEnd && (
            <span> — <span style={{ color: 'var(--muted)' }}>{endRQ.data?.display_name || (endRQ.isLoading ? 'resolving…' : '')}</span></span>
          )}
        </li>
      </ul>
    </div>
  )
}
