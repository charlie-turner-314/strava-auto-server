import './App.css'
import { useEffect, useState } from 'react'
import { StravaConnect } from './components/StravaConnect'
import { Activities } from './components/Activities'
import { Automations } from './components/Automations'
import { NavTabs } from './components/NavTabs'
import { ApplyAutomations } from './components/ApplyAutomations'
import { Counters } from './components/Counters'
import { ShoeStats } from './components/ShoeStats'
import { getAuthInit, getSession, logout } from './lib/api'

type TabKey = 'activities' | 'shoes' | 'automations' | 'apply' | 'counters'
type AuthState = 'checking' | 'unauthenticated' | 'authenticated'

export default function App() {
  const [tab, setTab] = useState<TabKey>('activities')
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [displayName, setDisplayName] = useState<string>('Strava athlete')

  useEffect(() => {
    let cancelled = false
    getSession()
      .then((info) => {
        if (cancelled) return
        if (info.authenticated) {
          setAuthState('authenticated')
          const name = [info.firstname, info.lastname].filter(Boolean).join(' ').trim()
          setDisplayName(name || info.username || `Athlete ${info.athlete_id ?? ''}`.trim())
        } else {
          setAuthState('unauthenticated')
        }
      })
      .catch(() => {
        if (!cancelled) setAuthState('unauthenticated')
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleLogout() {
    try {
      await logout()
    } catch (err) {
      console.warn('Failed to logout', err)
    } finally {
      setAuthState('unauthenticated')
    }
  }

  async function handleStravaLogin() {
    const { auth_url } = await getAuthInit()
    window.location.href = auth_url
  }

  if (authState !== 'authenticated') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6' }}>
        {authState === 'checking' ? (
          <div style={{ fontSize: 16, color: '#555' }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Sign in with Strava</h2>
            <button onClick={handleStravaLogin} style={{ padding: '10px 16px', fontSize: 14 }}>
              Continue with Strava
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <h1 style={{ marginTop: 0 }}>Strava Automator</h1>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span style={{ fontSize: 13, color: '#666' }}>Signed in as <strong>{displayName}</strong></span>
          <button
            type="button"
            onClick={handleLogout}
            style={{ padding: '6px 10px', fontSize: 13, cursor: 'pointer' }}
          >
            Log out
          </button>
        </div>
      </div>
      <StravaConnect />
      <NavTabs
        tabs={[
          { key: 'activities', label: 'Activities' },
          { key: 'shoes', label: 'Shoes' },
          { key: 'automations', label: 'Automations' },
          { key: 'apply', label: 'Apply Automations' },
          { key: 'counters', label: 'Counters' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as TabKey)}
      />
      {tab === 'activities'
        ? <Activities />
        : tab === 'shoes'
        ? <ShoeStats />
        : tab === 'automations'
        ? <Automations />
        : tab === 'apply'
        ? <ApplyAutomations />
        : <Counters />}
    </div>
  )
}
