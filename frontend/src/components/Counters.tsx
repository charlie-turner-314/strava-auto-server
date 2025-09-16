import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getCounters, resetCounter, resetAllCounters, reapplyCounters } from '../lib/api'
import { useState } from 'react'

export function Counters() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['counters'], queryFn: getCounters, refetchInterval: 15000 })
  const [limit, setLimit] = useState<string>('')
  const [dryRun, setDryRun] = useState(true)

  const resetOne = useMutation({
    mutationFn: (key: string) => resetCounter(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counters'] }),
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

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Counters</h3>
      {list.isLoading && <div>Loading…</div>}
      {list.isError && <div>Failed to load counters</div>}
      {!list.isLoading && !list.isError && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
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
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th align="left" style={{ width: '40%' }}>Key</th>
                <th align="left" style={{ width: '40%' }}>Value</th>
                <th align="left" style={{ width: '20%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items || []).length === 0 ? (
                <tr><td colSpan={3} style={{ color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>No counters yet</td></tr>
              ) : (
                list.data!.items.map((it) => (
                  <tr key={it.key}>
                    <td style={{ borderTop: '1px solid var(--border)' }}><code>{it.key}</code></td>
                    <td style={{ borderTop: '1px solid var(--border)' }}>{it.value}</td>
                    <td style={{ borderTop: '1px solid var(--border)' }}>
                      <button onClick={() => resetOne.mutate(it.key)} disabled={resetOne.isPending}>Reset</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {reapply.data && (
            <div style={{ marginTop: 8, color: 'var(--muted)' }}>
              Result: updated {reapply.data.updated}, skipped {reapply.data.skipped}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default Counters

