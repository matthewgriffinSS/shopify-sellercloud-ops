import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ops dashboard',
  description: 'Shopify + Sellercloud unified view',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
