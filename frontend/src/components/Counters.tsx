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
    <div>
      <h3 style={{ marginTop: 0 }}>Counters</h3>
      {list.isLoading && <div>Loading…</div>}
      {list.isError && <div>Failed to load counters</div>}
      {!list.isLoading && !list.isError && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <button onClick={() => resetAll.mutate()} disabled={resetAll.isPending}>Reset All</button>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Limit</span>
                <input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder='e.g. 200' style={{ width: 100 }} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type='checkbox' checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Dry run</span>
              </label>
              <button onClick={() => reapply.mutate()} disabled={reapply.isPending} title='Reapply counter-based automations to all activities'>
                {reapply.isPending ? (dryRun ? 'Simulating…' : 'Reapplying…') : (dryRun ? 'Simulate Reapply' : 'Reapply Now')}
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>From date</span>
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
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            Stored value is the last value used; next automation run will use last + 1.
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
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
                <tr><td colSpan={4} style={{ color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>No counters yet</td></tr>
              ) : (
                list.data!.items.map((it) => {
                  const rawValue = edits[it.key] ?? String(it.value)
                  const parsedValue = Number(rawValue)
                  const canSet = rawValue.trim() !== '' && Number.isFinite(parsedValue) && Number.isInteger(parsedValue) && parsedValue >= 0
                  return (
                  <tr key={it.key}>
                    <td style={{ borderTop: '1px solid var(--border)' }}><code>{it.key}</code></td>
                    <td style={{ borderTop: '1px solid var(--border)' }}>{it.value}</td>
                    <td style={{ borderTop: '1px solid var(--border)' }}>{it.value + 1}</td>
                    <td style={{ borderTop: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
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
            <div style={{ marginTop: 8, color: 'var(--muted)' }}>
              Result: updated {reapply.data.updated}, skipped {reapply.data.skipped}
            </div>
          )}
          {reapplyAutos.data && (
            <div style={{ marginTop: 4, color: 'var(--muted)' }}>
              Date result: updated {reapplyAutos.data.updated}, skipped {reapplyAutos.data.skipped}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default Counters
