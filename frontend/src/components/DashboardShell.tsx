'use client';
/**
 * DashboardShell — shared auth-guard + header wrapper for all dashboard pages.
 * FIX (v64): Centralises the auth check, spinner, and header so sub-pages
 * don't each copy-paste the same guard logic.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { auth, clearTokens, getAccessToken, AuthTokens } from '@/lib/api';

type User = AuthTokens['user'];

const NAV = [
  { href: '/dashboard',              label: 'Overview',     icon: '🏠' },
  { href: '/dashboard/products',     label: 'Products',     icon: '🛍️' },
  { href: '/dashboard/orders',       label: 'Orders',       icon: '📦' },
  { href: '/dashboard/analytics',    label: 'Analytics',    icon: '📊' },
  { href: '/dashboard/campaigns',    label: 'Campaigns',    icon: '🤖' },
  { href: '/dashboard/integrations', label: 'Integrations', icon: '🔗' },
];

const ADMIN_NAV = { href: '/admin', label: 'Admin', icon: '🔑' };

export default function DashboardShell({ children }: { children: (user: User) => React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const [user, setUser]       = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getAccessToken()) { router.push('/'); return; }
    auth.me()
      .then((u) => setUser(u as User))
      .catch(() => { clearTokens(); router.push('/'); })
      .finally(() => setLoading(false));
  }, [router]);

  const handleLogout = async () => {
    await auth.logout().catch(() => {});
    clearTokens();
    router.push('/');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return null;

  const isAdmin = user.role === 'admin' || user.role === 'superadmin';
  const navItems = isAdmin ? [...NAV, ADMIN_NAV] : NAV;

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Sticky header */}
      <header className="border-b border-gray-800 bg-gray-900/60 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-sm">🤖</div>
              <span className="font-bold text-white hidden sm:block">AI Empire</span>
              {isAdmin && <span className="bg-amber-500/20 text-amber-400 text-xs px-2 py-0.5 rounded-full font-medium">Admin</span>}
            </Link>
            {/* Desktop nav */}
            <nav className="hidden md:flex items-center gap-1">
              {navItems.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${
                    pathname === n.href
                      ? 'bg-indigo-600/20 text-indigo-300 font-medium'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-gray-400 text-sm hidden sm:block">{user.fullName ?? user.email}</span>
            <button onClick={handleLogout} className="text-gray-400 hover:text-white text-sm transition-colors">
              Sign out
            </button>
          </div>
        </div>
        {/* Mobile nav */}
        <nav className="md:hidden flex gap-1 px-4 pb-2 overflow-x-auto">
          {navItems.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`flex-shrink-0 text-xs px-3 py-1.5 rounded-lg transition-colors ${
                pathname === n.href
                  ? 'bg-indigo-600/20 text-indigo-300 font-medium'
                  : 'text-gray-500 hover:text-white'
              }`}
            >
              {n.icon} {n.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {children(user)}
      </main>
    </div>
  );
}
