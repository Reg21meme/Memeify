import './globals.css'
import Link from 'next/link'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="mx-auto max-w-3xl p-6">
        <header className="mb-6 flex gap-4">
          <Link href="/">Home</Link>
        </header>
        {children}
      </body>
    </html>
  )
}
