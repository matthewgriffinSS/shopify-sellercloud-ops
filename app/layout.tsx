import type { Metadata } from 'next'
import './globals.css'
import { ConfirmDialogRoot } from './components/ConfirmDialog'

export const metadata: Metadata = {
  title: 'Ops dashboard',
  description: 'Shopify + Sellercloud unified view',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        {/* ConfirmDialogRoot must be mounted once, at the root. Any call to
            confirmDialog() from anywhere in the app renders through this. */}
        <ConfirmDialogRoot />
      </body>
    </html>
  )
}
