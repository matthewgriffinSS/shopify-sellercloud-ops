'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export default function LoginPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || 'Login failed')
        setSubmitting(false)
        return
      }
      router.push('/')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
      setSubmitting(false)
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 20px',
      }}
    >
      <form
        onSubmit={submit}
        style={{
          background: 'var(--surface)',
          border: '0.5px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '28px 32px',
          width: '100%',
          maxWidth: 360,
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>Operations dashboard</h1>
        <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 20px' }}>
          Enter the dashboard password to continue.
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 14,
            border: '0.5px solid var(--border-2)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface)',
            color: 'var(--text)',
            marginBottom: 12,
          }}
        />
        {error && (
          <div
            style={{
              fontSize: 13,
              color: 'var(--danger-text)',
              marginBottom: 12,
              padding: '8px 12px',
              background: 'var(--danger-bg)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={submitting || !password}
          className="btn btn-primary"
          style={{ width: '100%' }}
        >
          {submitting ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
