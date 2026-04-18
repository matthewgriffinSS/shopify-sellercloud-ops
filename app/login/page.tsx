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
        background: 'var(--bg)',
      }}
    >
      <form
        onSubmit={submit}
        style={{
          background: 'var(--bg2)',
          border: '1px solid var(--border)',
          borderTop: '4px solid var(--accent)',
          borderRadius: '12px',
          padding: '32px 36px',
          width: '100%',
          maxWidth: 380,
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
        }}
      >
        <h1
          style={{
            fontFamily: 'var(--font-industrial)',
            fontSize: 28,
            fontWeight: 400,
            margin: '0 0 4px',
            color: '#fff',
            letterSpacing: '4px',
            textTransform: 'uppercase',
            lineHeight: 1,
          }}
        >
          Ops Dashboard
        </h1>
        <p
          style={{
            fontSize: 11,
            color: 'var(--text2)',
            margin: '0 0 24px',
            textTransform: 'uppercase',
            letterSpacing: '1px',
            fontWeight: 500,
          }}
        >
          Enter password to continue
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          style={{
            width: '100%',
            padding: '11px 14px',
            fontSize: 14,
            border: '1px solid var(--border)',
            borderRadius: '6px',
            background: 'var(--bg3)',
            color: 'var(--text)',
            marginBottom: 12,
            fontFamily: 'var(--font-body)',
          }}
        />
        {error && (
          <div
            style={{
              fontSize: 10,
              color: 'var(--red)',
              marginBottom: 12,
              padding: '9px 12px',
              background: 'rgba(255, 69, 58, 0.12)',
              border: '1px solid rgba(255, 69, 58, 0.3)',
              borderRadius: '6px',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              fontWeight: 600,
            }}
          >
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={submitting || !password}
          className="btn btn-primary"
          style={{ width: '100%', padding: '11px 16px', fontSize: 12 }}
        >
          {submitting ? 'Checking…' : 'Sign In'}
        </button>
      </form>
    </main>
  )
}
