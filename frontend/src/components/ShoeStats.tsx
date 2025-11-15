import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getShoeStats, type ShoeStatsItem } from '../lib/api'
import { formatDateTime, formatDistance, formatDuration, formatPace } from '../lib/format'

type SortKey =
  | 'name'
  | 'activity_count'
  | 'total_distance'
  | 'total_moving_time'
  | 'avg_pace'
  | 'avg_cadence'
  | 'lifetime_distance'
  | 'last_activity_at'

type SortDirection = 'asc' | 'desc'

type SortState = {
  key: SortKey
  direction: SortDirection
}

const DEFAULT_SORT: SortState = { key: 'total_distance', direction: 'desc' }

function getSortValue(item: ShoeStatsItem, key: SortKey): string | number | null | undefined {
  switch (key) {
    case 'name':
      return item.name || ''
    case 'activity_count':
      return item.activity_count
    case 'total_distance':
      return item.total_distance
    case 'total_moving_time':
      return item.total_moving_time
    case 'avg_pace':
      return item.avg_pace_s_per_km
    case 'avg_cadence':
      return item.avg_cadence
    case 'lifetime_distance':
      return item.lifetime_distance
    case 'last_activity_at':
      return item.last_activity_at
    default:
      return undefined
  }
}

function normalizeNumber(value: number | null | undefined, direction: SortDirection): number {
  if (value == null || Number.isNaN(Number(value))) {
    return direction === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  }
  return Number(value)
}

function normalizeString(value: string | null | undefined): string {
  if (!value) return ''
  return value.toLowerCase()
}

function renderSortLabel(label: string, active: boolean, direction: SortDirection): string {
  if (!active) return label
  return `${label}${direction === 'asc' ? ' ^' : ' v'}`
}

export function ShoeStats() {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT)
  const query = useQuery({ queryKey: ['shoe-stats'], queryFn: getShoeStats, refetchInterval: 60000 })

  const items = useMemo(() => {
    const list = [...(query.data?.items ?? [])]
    list.sort((a, b) => {
      const aVal = getSortValue(a, sort.key)
      const bVal = getSortValue(b, sort.key)
      if (sort.key === 'name' || sort.key === 'last_activity_at' || typeof aVal === 'string' || typeof bVal === 'string') {
        let aRaw = (typeof aVal === 'string' ? aVal : (aVal as string | null | undefined)) ?? ''
        let bRaw = (typeof bVal === 'string' ? bVal : (bVal as string | null | undefined)) ?? ''
        if (sort.key === 'last_activity_at') {
          if (!aRaw) {
            aRaw = sort.direction === 'asc' ? '9999-12-31T23:59:59' : '0000-01-01T00:00:00'
          }
          if (!bRaw) {
            bRaw = sort.direction === 'asc' ? '9999-12-31T23:59:59' : '0000-01-01T00:00:00'
          }
        }
        const aStr = normalizeString(aRaw)
        const bStr = normalizeString(bRaw)
        if (aStr !== bStr) {
          return sort.direction === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr)
        }
      } else {
        const aNum = normalizeNumber(aVal as number | undefined, sort.direction)
        const bNum = normalizeNumber(bVal as number | undefined, sort.direction)
        if (aNum !== bNum) {
          return sort.direction === 'asc' ? aNum - bNum : bNum - aNum
        }
      }
      const aName = normalizeString(a.name)
      const bName = normalizeString(b.name)
      return aName.localeCompare(bName)
    })
    return list
  }, [query.data, sort])

  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
      }
      const defaultDir: SortDirection = key === 'name' || key === 'last_activity_at' ? 'asc' : 'desc'
      return { key, direction: defaultDir }
    })
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Shoes</h3>
      {query.isLoading && <div>Loading shoes…</div>}
      {query.isError && <div style={{ color: 'crimson' }}>Failed to load shoes</div>}
      {!query.isLoading && !query.isError && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th align="left" style={{ width: '26%' }}>
                  <button
                    type="button"
                    onClick={() => toggleSort('name')}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: sort.key === 'name' ? 600 : 400 }}
                  >
                    {renderSortLabel('Shoe', sort.key === 'name', sort.direction)}
                  </button>
                </th>
                <th align="right" style={{ width: '10%' }}>
                  <button
                    type="button"
                    onClick={() => toggleSort('activity_count')}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: sort.key === 'activity_count' ? 600 : 400 }}
                  >
                    {renderSortLabel('Activities', sort.key === 'activity_count', sort.direction)}
                  </button>
                </th>
                <th align="right" style={{ width: '13%' }}>
                  <button
                    type="button"
                    onClick={() => toggleSort('total_distance')}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: sort.key === 'total_distance' ? 600 : 400 }}
                  >
                    {renderSortLabel('Total Distance', sort.key === 'total_distance', sort.direction)}
                  </button>
                </th>
                <th align="right" style={{ width: '12%' }}>
                  <button
                    type="button"
                    onClick={() => toggleSort('total_moving_time')}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: sort.key === 'total_moving_time' ? 600 : 400 }}
                  >
                    {renderSortLabel('Moving Time', sort.key === 'total_moving_time', sort.direction)}
                  </button>
                </th>
                <th align="right" style={{ width: '11%' }}>
                  <button
                    type="button"
                    onClick={() => toggleSort('avg_pace')}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: sort.key === 'avg_pace' ? 600 : 400 }}
                  >
                    {renderSortLabel('Avg Pace', sort.key === 'avg_pace', sort.direction)}
                  </button>
                </th>
                <th align="right" style={{ width: '10%' }}>
                  <button
                    type="button"
                    onClick={() => toggleSort('avg_cadence')}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: sort.key === 'avg_cadence' ? 600 : 400 }}
                  >
                    {renderSortLabel('Avg Cadence', sort.key === 'avg_cadence', sort.direction)}
                  </button>
                </th>
                <th align="right" style={{ width: '10%' }}>
                  <button
                    type="button"
                    onClick={() => toggleSort('lifetime_distance')}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: sort.key === 'lifetime_distance' ? 600 : 400 }}
                  >
                    {renderSortLabel('Lifetime Dist', sort.key === 'lifetime_distance', sort.direction)}
                  </button>
                </th>
                <th align="left" style={{ width: '18%' }}>
                  <button
                    type="button"
                    onClick={() => toggleSort('last_activity_at')}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: sort.key === 'last_activity_at' ? 600 : 400 }}
                  >
                    {renderSortLabel('Last Activity', sort.key === 'last_activity_at', sort.direction)}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ borderTop: '1px solid var(--border)', color: 'var(--muted)' }}>No shoes yet</td>
                </tr>
              ) : (
                items.map((shoe) => {
                  const pace = formatPace(shoe.avg_pace_s_per_km)
                  const cadence = shoe.avg_cadence == null ? '' : `${shoe.avg_cadence.toFixed(1)} spm`
                  const totalDist = formatDistance(shoe.total_distance)
                  const lifetime = formatDistance(shoe.lifetime_distance)
                  const moving = formatDuration(shoe.total_moving_time)
                  const last = formatDateTime(shoe.last_activity_at)
                  return (
                    <tr key={shoe.gear_id}>
                      <td style={{ borderTop: '1px solid var(--border)' }}>
                        <div style={{ fontWeight: 600 }}>{shoe.name || '(unnamed)'}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                          <code>{shoe.gear_id}</code>
                          {shoe.is_primary && <span style={{ marginLeft: 6, fontWeight: 500 }}>(primary)</span>}
                        </div>
                      </td>
                      <td style={{ borderTop: '1px solid var(--border)', textAlign: 'right' }}>{shoe.activity_count}</td>
                      <td style={{ borderTop: '1px solid var(--border)', textAlign: 'right' }}>{totalDist || '0.00km'}</td>
                      <td style={{ borderTop: '1px solid var(--border)', textAlign: 'right' }}>{moving || '00m00s'}</td>
                      <td style={{ borderTop: '1px solid var(--border)', textAlign: 'right' }}>{pace || '--'}</td>
                      <td style={{ borderTop: '1px solid var(--border)', textAlign: 'right' }}>{cadence || '--'}</td>
                      <td style={{ borderTop: '1px solid var(--border)', textAlign: 'right' }}>{lifetime || '--'}</td>
                      <td style={{ borderTop: '1px solid var(--border)' }}>{last || ''}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

export default ShoeStats
