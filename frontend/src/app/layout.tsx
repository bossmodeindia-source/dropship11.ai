import type { Metadata } from 'next';
import { Toaster } from 'sonner'; // FIX: was installed but never mounted
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'AI Empire — Autonomous Commerce Platform',
  description: 'AI-powered dropshipping and e-commerce automation',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-white antialiased">
        {children}
        {/* FIX (v64): Sonner was in package.json but Toaster was never added */}
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: '#111827',
              border: '1px solid #1f2937',
              color: '#f9fafb',
            },
          }}
        />
      </body>
    </html>
  );
}
