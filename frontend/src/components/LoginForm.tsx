import { FormEvent, useState } from 'react'
import { login } from '../lib/api'

type Props = {
  onSuccess: (username: string) => void
}

export function LoginForm({ onSuccess }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const trimmed = username.trim()
      const res = await login(trimmed, password)
      if (res.authenticated) {
        onSuccess(res.username ?? trimmed)
        setPassword('')
        return
      }
      setError('Invalid credentials')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed'
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ width: 320, padding: 24, borderRadius: 12, boxShadow: '0 6px 24px rgba(0,0,0,0.08)', background: '#fff', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 20 }}>Sign In</h1>
        <p style={{ margin: '4px 0 0', color: '#666', fontSize: 13 }}>Enter the admin credentials to continue.</p>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
        Username
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
          disabled={busy}
          style={{ padding: '8px 10px', fontSize: 14 }}
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          disabled={busy}
          style={{ padding: '8px 10px', fontSize: 14 }}
        />
      </label>
      {error ? <div style={{ color: '#b00020', fontSize: 13 }}>{error}</div> : null}
      <button type="submit" disabled={busy} style={{ padding: '10px 12px', fontSize: 14, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer' }}>
        {busy ? 'Signing in…' : 'Sign In'}
      </button>
    </form>
  )
}
