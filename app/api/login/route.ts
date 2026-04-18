import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE, issueCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/login with { password } body.
 * Sets a signed cookie on success.
 */
export async function POST(req: NextRequest) {
  const expected = process.env.DASHBOARD_PASSWORD
  if (!expected) {
    return NextResponse.json({ ok: true, required: false })
  }

  let body: { password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (body.password !== expected) {
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 })
  }

  const res = NextResponse.json({ ok: true })
  res.cookies.set(AUTH_COOKIE.name, issueCookieValue(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: AUTH_COOKIE.maxAge,
    path: '/',
  })
  return res
}

/**
 * DELETE /api/login — log out.
 */
export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.delete(AUTH_COOKIE.name)
  return res
}
