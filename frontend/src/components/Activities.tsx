import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { getActivities, runIngestNow, deleteActivity, clearActivities, previewActivity, applyActivity, getActivityAudit, refreshActivity, type ActivitiesPage, type Activity } from '../lib/api'
import { formatDateTime, formatDistance, formatDuration } from '../lib/format'

const PAGE_SIZE = 10
const SPORTS = ['', 'Run', 'Ride', 'Walk', 'Hike', 'Swim', 'VirtualRide']

export function Activities() {
  const qc = useQueryClient()
  const [offset, setOffset] = useState(0)
  const [sport, setSport] = useState('')
  const [ingesting, setIngesting] = useState(false)
  const [updatingId, setUpdatingId] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  function showToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2500)
  }
  const q = useQuery<ActivitiesPage>({
    queryKey: ['activities', PAGE_SIZE, offset, sport],
    queryFn: () => getActivities(PAGE_SIZE, offset, sport || undefined),
    placeholderData: (prev) => prev,
    refetchInterval: 30000,
  })

  const total = q.data?.total ?? 0
  const items: Activity[] = q.data?.items ?? []
  const canPrev = offset > 0
  const canNext = offset + PAGE_SIZE < total
  const [detailId, setDetailId] = useState<number | null>(null)
  const detail = useQuery({
    queryKey: ['activity-preview', detailId],
    queryFn: () => previewActivity(detailId as number),
    enabled: detailId != null,
  })
  const audit = useQuery({
    queryKey: ['activity-audit', detailId],
    queryFn: () => getActivityAudit(detailId as number, 20),
    enabled: detailId != null,
  })

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="toolbar-group">
          <h3 className="panel-title">Activities</h3>
          <span className="muted">Total: {total}</span>
          <label className="field">
            <span>Sport</span>
            <select value={sport} onChange={(e) => { setOffset(0); setSport(e.target.value) }}>
              {SPORTS.map((s) => (
                <option key={s || 'all'} value={s}>{s || 'All'}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="toolbar-group">
          <button
            onClick={async () => {
              try {
                setIngesting(true)
                const r = await runIngestNow()
                qc.invalidateQueries({ queryKey: ['activities'] })
                const msg = r.message || `Ingested: +${r.inserted}, updated: ${r.updated}`
                showToast(msg)
                console.debug('Ingest response', r)
              } finally {
                setIngesting(false)
              }
            }}
            disabled={ingesting}
            title="Fetch latest activities now"
          >{ingesting ? 'Refreshing…' : 'Refresh now'}</button>
          <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={!canPrev}>
            Prev
          </button>
          <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={!canNext}>
            Next
          </button>
        </div>
      </div>
      {detailId != null && (
        <div className="subpanel" style={{ marginBottom: 12 }}>
          <div className="panel-header" style={{ marginBottom: 8 }}>
            <strong>Activity {detailId}</strong>
            <button onClick={() => setDetailId(null)}>Close</button>
          </div>
          {detail.isLoading && <div>Loading preview…</div>}
          {detail.isError && <div>Failed to load preview</div>}
          {detail.data && (
            <div className="panel-grid">
              <div>
                <div className="panel-subtitle">Will apply changes?</div>
                <div><strong>{detail.data.applies ? 'Yes' : 'No'}</strong></div>
                <div style={{ marginTop: 8 }} className="panel-subtitle">Matched automations</div>
                {detail.data.matched_automations.length === 0 ? (
                  <div className="muted-weak">None</div>
                ) : (
                  <ul>
                    {detail.data.matched_automations.map(m => <li key={m.id}><code>{m.name}</code></li>)}
                  </ul>
                )}
              </div>
              <div>
                <div className="panel-subtitle">Desired fields</div>
                <ul>
                  {'name' in detail.data.desired && (
                    <li>Title: <code>{String(detail.data.desired.name ?? '')}</code></li>
                  )}
                  {'sport_type' in detail.data.desired && (
                    <li>Sport: <code>{String(detail.data.desired.sport_type ?? '')}</code></li>
                  )}
                  {'description' in detail.data.desired && detail.data.desired.description !== undefined && (
                    <li>Description: <code>{String(detail.data.desired.description ?? '')}</code></li>
                  )}
                  {'commute' in detail.data.desired && detail.data.desired.commute !== undefined && (
                    <li>Commute: <code>{String(detail.data.desired.commute)}</code></li>
                  )}
                  {'workout_type' in detail.data.desired && detail.data.desired.workout_type !== undefined && (
                    <li>Workout type: <code>{String(detail.data.desired.workout_type)}</code></li>
                  )}
                  {'gear_id' in detail.data.desired && detail.data.desired.gear_id !== undefined && (
                    <li>Shoes (gear_id): <code>{String(detail.data.desired.gear_id)}</code></li>
                  )}
                  {'hide_from_home' in detail.data.desired && detail.data.desired.hide_from_home !== undefined && (
                    <li>Hide from feeds: <code>{String(detail.data.desired.hide_from_home)}</code></li>
                  )}
                </ul>
                <div>
                  <button
                    onClick={async () => {
                      const res = await applyActivity(detailId)
                      if (res.updated) {
                        showToast('Applied changes')
                        qc.invalidateQueries({ queryKey: ['activities'] })
                        detail.refetch()
                        audit.refetch()
                      } else {
                        showToast('No changes to apply')
                      }
                    }}
                  >Apply now</button>
                </div>
              </div>
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <div className="panel-subtitle">Recent automation runs</div>
            {audit.isLoading && <div>Loading…</div>}
            {audit.isError && <div>Failed to load audit</div>}
            {audit.data && audit.data.items.length === 0 && <div className="muted-weak">None</div>}
            {audit.data && audit.data.items.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th align="left">When</th>
                    <th align="left">Source</th>
                    <th align="left">Automations</th>
                    <th align="left">Changes</th>
                    <th align="left">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.items.map((it) => (
                    <tr key={it.id}>
                      <td>{formatDateTime(it.created_at)}</td>
                      <td>{it.source}</td>
                      <td><code>{it.automation_ids.join(', ')}</code></td>
                      <td><code>{JSON.stringify(it.changes)}</code></td>
                      <td style={{ color: it.error ? 'var(--danger)' : 'var(--muted-weak)' }}>{it.error || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
      {toast && (
        <div className="toast toast--success">
          {toast}
        </div>
      )}
      {q.isLoading && <div>Loading…</div>}
      {q.isError && <div>Failed to load activities</div>}
      {!q.isLoading && !q.isError && (
        <table className="table" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th align="left" style={{ width: '18%' }}>Date</th>
              <th align="left" style={{ width: '10%' }}>Sport</th>
              <th align="left" style={{ width: '34%' }}>Name</th>
              <th align="left" style={{ width: '18%' }}>Tags</th>
              <th align="right" style={{ width: '10%' }}>Distance</th>
              <th align="right" style={{ width: '10%' }}>Moving</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td style={{ padding: '4px 0' }}>{formatDateTime(a.start_date_local || a.start_date)}</td>
                <td>{a.sport_type || ''}</td>
                <td style={{ overflowWrap: 'anywhere' }}>{a.name || ''}</td>
                <td>
                  {(a.commute || a.workout_type === 2 || a.hide_from_home) ? (
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {a.commute && <Tag>Commute</Tag>}
                      {a.workout_type === 2 && <Tag>Long run</Tag>}
                      {a.hide_from_home && <Tag>Muted</Tag>}
                    </span>
                  ) : (
                    <span className="muted-weak">—</span>
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>{formatDistance(a.distance)}</td>
                <td style={{ textAlign: 'right' }}>{formatDuration(a.moving_time)}</td>
                <td style={{ textAlign: 'right' }}>
                  <div className="panel-actions" style={{ justifyContent: 'flex-end' }}>
                    <button
                      onClick={async () => {
                        setUpdatingId(a.id)
                        try {
                          const res = await refreshActivity(a.id)
                          const msg = res.message || (res.updated ? 'Activity refreshed from Strava' : 'No new details from Strava')
                          showToast(msg)
                          console.debug('Activity refresh', res)
                          qc.invalidateQueries({ queryKey: ['activities'] })
                          if (detailId === a.id) {
                            detail.refetch()
                            audit.refetch()
                          }
                        } catch (err) {
                          console.error('Refresh failed', err)
                          const msg = err instanceof Error ? err.message : 'Failed to refresh activity'
                          showToast(msg)
                        } finally {
                          setUpdatingId(null)
                        }
                      }}
                      disabled={updatingId === a.id}
                      title="Fetch latest fields for this activity"
                    >{updatingId === a.id ? 'Updating…' : 'Update'}</button>
                    <button
                      onClick={async () => {
                        await deleteActivity(a.id)
                        qc.invalidateQueries({ queryKey: ['activities'] })
                        showToast(`Deleted ${a.id} locally`)
                      }}
                      title="Delete locally"
                    >Delete</button>
                    <button onClick={() => setDetailId(a.id)}>Details</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ marginTop: 8 }}>
        <button
          onClick={async () => {
            const { deleted } = await clearActivities()
            qc.invalidateQueries({ queryKey: ['activities'] })
            showToast(`Cleared ${deleted} activities`)
          }}
          title="Clear all local activities"
        >Clear all</button>
      </div>
    </section>
  )
}

export default Activities

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="tag">
      {children}
    </span>
  )
}
