import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getCounters, resetCounter, resetAllCounters, reapplyCounters, reapplyAutomations, setCounter } from '../lib/api'
import { useState } from 'react'

export function Counters() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['counters'], queryFn: getCounters, refetchInterval: 15000 })
  const [limit, setLimit] = useState<string>('')
  const [dryRun, setDryRun] = useState(true)
  const [since, setSince] = useState<string>('')
  const [edits, setEdits] = useState<Record<string, string>>({})

  const resetOne = useMutation({
    mutationFn: (key: string) => resetCounter(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counters'] }),
  })
  const setOne = useMutation({
    mutationFn: ({ key, value }: { key: string; value: number }) => setCounter(key, value),
    onSuccess: (data) => {
      setEdits((prev) => ({ ...prev, [data.key]: String(data.value) }))
      qc.invalidateQueries({ queryKey: ['counters'] })
    },
  })
  const resetAll = useMutation({
    mutationFn: () => resetAllCounters(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counters'] }),
  })
  const reapply = useMutation({
    mutationFn: async () => {
      const lim = limit.trim() ? Number(limit) : undefined
      return reapplyCounters(dryRun, lim)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counters'] }),
  })
  const reapplyAutos = useMutation({
    mutationFn: async () => {
      const lim = limit.trim() ? Number(limit) : undefined
      return reapplyAutomations(since, dryRun, lim)
    },
  })

  return (
    <section className="panel">
      <div className="panel-header">
        <h3 className="panel-title">Counters</h3>
        <span className="panel-subtitle">Auto-increment values for templates</span>
      </div>
      {list.isLoading && <div>Loading…</div>}
      {list.isError && <div>Failed to load counters</div>}
      {!list.isLoading && !list.isError && (
        <>
          <div className="toolbar">
            <div className="toolbar-group">
              <button onClick={() => resetAll.mutate()} disabled={resetAll.isPending}>Reset All</button>
            </div>
            <div className="toolbar-group">
              <label className="field">
                <span>Limit</span>
                <input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder='e.g. 200' style={{ width: 100 }} />
              </label>
              <label className="field">
                <input type='checkbox' checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                <span>Dry run</span>
              </label>
              <button onClick={() => reapply.mutate()} disabled={reapply.isPending} title='Reapply counter-based automations to all activities'>
                {reapply.isPending ? (dryRun ? 'Simulating…' : 'Reapplying…') : (dryRun ? 'Simulate Reapply' : 'Reapply Now')}
              </button>
            </div>
          </div>
          <div className="toolbar">
            <div className="toolbar-group">
              <label className="field">
                <span>From date</span>
                <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
              </label>
              <button
                onClick={() => reapplyAutos.mutate()}
                disabled={reapplyAutos.isPending || !since}
                title='Reapply all automations from a given date'
              >
                {reapplyAutos.isPending ? (dryRun ? 'Simulating…' : 'Reapplying…') : (dryRun ? 'Simulate Reapply (Date)' : 'Reapply From Date')}
              </button>
            </div>
          </div>
          <div className="notice">
            Stored value is the last value used; next automation run will use last + 1.
          </div>
          <table className="table" style={{ tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th align="left" style={{ width: '30%' }}>Key</th>
                <th align="left" style={{ width: '15%' }}>Last used</th>
                <th align="left" style={{ width: '15%' }}>Next value</th>
                <th align="left" style={{ width: '40%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items || []).length === 0 ? (
                <tr><td colSpan={4} className="muted">No counters yet</td></tr>
              ) : (
                list.data!.items.map((it) => {
                  const rawValue = edits[it.key] ?? String(it.value)
                  const parsedValue = Number(rawValue)
                  const canSet = rawValue.trim() !== '' && Number.isFinite(parsedValue) && Number.isInteger(parsedValue) && parsedValue >= 0
                  return (
                  <tr key={it.key}>
                    <td><code>{it.key}</code></td>
                    <td>{it.value}</td>
                    <td>{it.value + 1}</td>
                    <td>
                      <div className="panel-actions">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={rawValue}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [it.key]: e.target.value }))}
                          style={{ width: 110 }}
                          placeholder="Last used"
                          aria-label={`Set ${it.key} counter value`}
                        />
                        <button
                          onClick={() => {
                            if (!canSet) return
                            setOne.mutate({ key: it.key, value: parsedValue })
                          }}
                          disabled={setOne.isPending || !canSet}
                        >
                          Set
                        </button>
                        <button onClick={() => resetOne.mutate(it.key)} disabled={resetOne.isPending}>Reset</button>
                      </div>
                    </td>
                  </tr>
                )})
              )}
            </tbody>
          </table>
          {reapply.data && (
            <div className="notice" style={{ marginTop: 8 }}>
              Result: updated {reapply.data.updated}, skipped {reapply.data.skipped}
            </div>
          )}
          {reapplyAutos.data && (
            <div className="notice" style={{ marginTop: 4 }}>
              Date result: updated {reapplyAutos.data.updated}, skipped {reapplyAutos.data.skipped}
            </div>
          )}
        </>
      )}
    </section>
  )
}

export default Counters
