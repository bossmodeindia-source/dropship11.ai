'use client';
/**
 * Admin Panel — V64
 * FIX: This page was linked in dashboard for admin/superadmin users but didn't exist → 404.
 * Role-protected client-side: non-admins are redirected to /dashboard.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { auth, adminApi, clearTokens, getAccessToken, AdminUser, Paginated, AuthTokens } from '@/lib/api';
import Link from 'next/link';

type User = AuthTokens['user'];

const ROLE_COLORS: Record<string, string> = {
  superadmin: 'text-red-400 bg-red-900/30',
  admin:      'text-amber-400 bg-amber-900/30',
  user:       'text-blue-400 bg-blue-900/30',
};

const TIER_COLORS: Record<string, string> = {
  free:       'text-gray-400 bg-gray-800',
  starter:    'text-green-400 bg-green-900/30',
  pro:        'text-indigo-400 bg-indigo-900/30',
  enterprise: 'text-purple-400 bg-purple-900/30',
};

export default function AdminPage() {
  const router = useRouter();
  const [me, setMe]           = useState<User | null>(null);
  const [users, setUsers]     = useState<Paginated<AdminUser> | null>(null);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(true);
  const [usersLoading, setUsersLoading] = useState(true);

  // Auth guard
  useEffect(() => {
    if (!getAccessToken()) { router.push('/'); return; }
    auth.me()
      .then((u) => {
        setMe(u as User);
        if (u.role !== 'admin' && u.role !== 'superadmin') {
          toast.error('Access denied');
          router.push('/dashboard');
        }
      })
      .catch(() => { clearTokens(); router.push('/'); })
      .finally(() => setLoading(false));
  }, [router]);

  const loadUsers = (p: number) => {
    setUsersLoading(true);
    adminApi.users(p, 50)
      .then((d) => { setUsers(d); setPage(p); })
      .catch(() => toast.error('Failed to load users'))
      .finally(() => setUsersLoading(false));
  };

  useEffect(() => {
    if (me) loadUsers(1);
  }, [me]);

  const handleLogout = async () => {
    await auth.logout().catch(() => {});
    clearTokens();
    router.push('/');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!me) return null;

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/60 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm">
              ← Dashboard
            </Link>
            <span className="text-gray-700">/</span>
            <span className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-amber-600 flex items-center justify-center text-xs">🔑</div>
              <span className="font-bold text-white">Admin Panel</span>
              <span className="bg-red-500/20 text-red-400 text-xs px-2 py-0.5 rounded-full font-medium uppercase tracking-wide">
                {me.role}
              </span>
            </span>
          </div>
          <button onClick={handleLogout} className="text-gray-400 hover:text-white text-sm transition-colors">
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Total Users',   value: users ? String(users.total) : '—', color: 'blue' },
            { label: 'Active Today',  value: '—', color: 'green' },
            { label: 'Revenue MTD',   value: '—', color: 'indigo' },
            { label: 'System Health', value: 'OK', color: 'green' },
          ].map((c) => (
            <div key={c.label} className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
              <p className="text-gray-400 text-xs mb-1">{c.label}</p>
              <p className={`text-2xl font-bold text-${c.color}-400`}>{c.value}</p>
            </div>
          ))}
        </div>

        {/* Users table */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
            <h2 className="font-semibold text-white">Users</h2>
            {users && (
              <span className="text-gray-500 text-sm">{users.total} total</span>
            )}
          </div>

          {usersLoading ? (
            <div className="p-8 flex justify-center">
              <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : !users?.data.length ? (
            <div className="p-12 text-center text-gray-500">
              <p className="text-4xl mb-3">👥</p>
              <p className="font-medium text-white mb-1">No users found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400 text-left">
                    <th className="px-6 py-3 font-medium">User</th>
                    <th className="px-6 py-3 font-medium">Role</th>
                    <th className="px-6 py-3 font-medium">Plan</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 font-medium">Joined</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {users.data.map((u) => (
                    <tr key={u.id} className="hover:bg-gray-800/50 transition-colors">
                      <td className="px-6 py-4">
                        <p className="text-white font-medium">{u.fullName ?? '—'}</p>
                        <p className="text-gray-500 text-xs">{u.email}</p>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`text-xs font-medium px-2 py-1 rounded-full ${ROLE_COLORS[u.role] ?? 'text-gray-400 bg-gray-800'}`}>
                          {u.role}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`text-xs font-medium px-2 py-1 rounded-full capitalize ${TIER_COLORS[u.subscriptionTier] ?? 'text-gray-400 bg-gray-800'}`}>
                          {u.subscriptionTier}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`text-xs font-medium px-2 py-1 rounded-full ${u.isActive ? 'text-green-400 bg-green-900/30' : 'text-red-400 bg-red-900/30'}`}>
                          {u.isActive ? 'Active' : 'Suspended'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-gray-500">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        {users && users.total > 50 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-gray-500 text-sm">Page {page} of {Math.ceil(users.total / 50)}</p>
            <div className="flex gap-2">
              <button onClick={() => loadUsers(page - 1)} disabled={page <= 1 || usersLoading}
                className="px-4 py-2 text-sm bg-gray-900 border border-gray-700 rounded-lg text-gray-300 hover:border-amber-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                Previous
              </button>
              <button onClick={() => loadUsers(page + 1)} disabled={page >= Math.ceil(users.total / 50) || usersLoading}
                className="px-4 py-2 text-sm bg-gray-900 border border-gray-700 rounded-lg text-gray-300 hover:border-amber-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                Next
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
