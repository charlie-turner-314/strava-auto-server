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
      <div className="landing-shell">
        <div className="landing-card">
          <div className="landing-badge">Strava Automator</div>
          <h1 className="landing-title">Make your activities self-cleaning.</h1>
          <p className="landing-subtitle">
            Craft rules once. Keep titles tidy, flag commutes, and sync gear
            without touching every workout.
          </p>
          <div className="landing-tags">
            <span className="landing-tag">Clean titles</span>
            <span className="landing-tag">Commute flags</span>
            <span className="landing-tag">Gear auto-assign</span>
          </div>
          {authState === 'checking' ? (
            <div className="landing-status">Checking session…</div>
          ) : (
            <div className="landing-cta">
              <button type="button" className="btn-primary" onClick={handleStravaLogin}>
                Continue with Strava
              </button>
              <span className="landing-note">Secure OAuth. Your tokens stay private.</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <div className="app-container">
        <div className="app-header">
          <div>
            <h1 className="app-title">Strava Automator</h1>
            <div className="app-subtitle">Rule-driven cleanup for every ride, run, and hike.</div>
          </div>
          <div className="app-user">
            <span>Signed in as <strong>{displayName}</strong></span>
            <button
              type="button"
              onClick={handleLogout}
              className="btn-ghost"
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
    </div>
  )
}
