import { vi } from 'vitest'
import React from 'react'

type MemoryStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  clear: () => void
  key: (index: number) => string | null
  readonly length: number
}

function createMemoryStorage(): MemoryStorage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  }
}

const storageFallback = createMemoryStorage()
const hasValidStorage =
  typeof globalThis.localStorage !== 'undefined' &&
  typeof globalThis.localStorage.getItem === 'function'

if (!hasValidStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storageFallback,
    configurable: true,
  })
}

if (
  typeof globalThis.sessionStorage === 'undefined' ||
  typeof globalThis.sessionStorage.getItem !== 'function'
) {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: storageFallback,
    configurable: true,
  })
}

vi.mock('recharts', () => {
  const ResponsiveContainer = ({ children, width, height }: { children: React.ReactNode; width?: number | string; height?: number | string }) => (
    <div data-testid="responsive-container" style={{ width: width || '100%', height: typeof height === 'number' ? `${height}px` : height }}>{children}</div>
  )
  const SimpleWrapper = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  const Line = () => null
  const CartesianGrid = () => null
  const ReferenceLine = () => null
  const Tooltip = () => null
  const XAxis = () => null
  const YAxis = () => null
  return {
    ResponsiveContainer,
    LineChart: SimpleWrapper,
    Line,
    XAxis,
    YAxis,
    Tooltip,
    CartesianGrid,
    ReferenceLine,
  }
})
