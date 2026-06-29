'use client';
/**
 * Dashboard overview page — V64
 * FIX: replaced <a> tags with Next.js <Link> (no full-page reloads)
 * FIX: system status label updated V63 → V64
 * FIX: uses DashboardShell for shared auth guard + header
 * FIX: live API call for dashboard summary stats
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { dashboard, DashboardSummary } from '@/lib/api';
import DashboardShell from '@/components/DashboardShell';

const StatCard = ({
  label, value, sub, color = 'indigo',
}: { label: string; value: string; sub?: string; color?: string }) => (
  <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
    <p className="text-gray-400 text-sm mb-1">{label}</p>
    <p className={`text-3xl font-bold text-${color}-400`}>{value}</p>
    {sub && <p className="text-gray-500 text-xs mt-1">{sub}</p>}
  </div>
);

const NAV_CARDS = [
  { icon: '🛍️', title: 'Products',     desc: 'Score and list new products',  href: '/dashboard/products' },
  { icon: '📦', title: 'Orders',       desc: 'Manage fulfillment queue',      href: '/dashboard/orders' },
  { icon: '📊', title: 'Analytics',    desc: 'ROAS, CAC, LTV dashboards',     href: '/dashboard/analytics' },
  { icon: '🤖', title: 'AI Campaigns', desc: 'Launch and monitor ads',        href: '/dashboard/campaigns' },
  { icon: '🔗', title: 'Integrations', desc: 'Shopify, Meta, TikTok',         href: '/dashboard/integrations' },
];

const SYSTEMS = [
  'V64 Commerce Brain',
  'Trend Intelligence',
  'Viral Media Engine',
  'Supplier Routing',
  'Telegram Storage',
  'Autonomous Growth',
];

function fmt(n: number, currency = '₹') {
  if (n >= 1_000_000) return `${currency}${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${currency}${(n / 1_000).toFixed(1)}K`;
  return `${currency}${n.toFixed(0)}`;
}

export default function DashboardPage() {
  const [summary, setSummary]   = useState<DashboardSummary | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    dashboard.summary()
      .then(setSummary)
      .catch(() => toast.error('Could not load dashboard stats'))
      .finally(() => setStatsLoading(false));
  }, []);

  return (
    <DashboardShell>
      {(user) => {
        const isAdmin = user.role === 'admin' || user.role === 'superadmin';
        const cur = summary?.currency ?? '₹';
        const cards = isAdmin
          ? [...NAV_CARDS, { icon: '🔑', title: 'Admin Panel', desc: 'Users, keys, system', href: '/admin' }]
          : NAV_CARDS;

        return (
          <>
            <div className="mb-8">
              <h1 className="text-2xl font-bold text-white">
                Welcome back, {user.fullName?.split(' ')[0] ?? 'there'} 👋
              </h1>
              <p className="text-gray-400 text-sm mt-1">
                Plan:{' '}
                <span className="text-indigo-400 font-medium capitalize">
                  {user.subscriptionTier}
                </span>
              </p>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              {statsLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 animate-pulse">
                    <div className="h-3 bg-gray-700 rounded w-24 mb-3" />
                    <div className="h-8 bg-gray-700 rounded w-16" />
                  </div>
                ))
              ) : (
                <>
                  <StatCard label="Revenue Today"    value={summary ? fmt(summary.revenueToday, cur === 'INR' ? '₹' : '$') : '₹0'} sub="Live tracking"    color="green"  />
                  <StatCard label="Active Orders"    value={String(summary?.activeOrders ?? 0)}  sub="Fulfillment queue" color="blue"   />
                  <StatCard label="Products Listed"  value={String(summary?.productsListed ?? 0)} sub="Shopify sync"      color="indigo" />
                  <StatCard label="ROAS"             value={summary?.roas != null ? `${summary.roas.toFixed(2)}×` : '—'} sub="Last 7 days" color="purple" />
                </>
              )}
            </div>

            {/* Nav cards — FIX: Link instead of <a> */}
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {cards.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-indigo-700 transition-all group"
                >
                  <div className="text-2xl mb-3">{item.icon}</div>
                  <h3 className="font-semibold text-white group-hover:text-indigo-300 transition-colors">
                    {item.title}
                  </h3>
                  <p className="text-gray-500 text-sm mt-1">{item.desc}</p>
                </Link>
              ))}
            </div>

            {/* System status — FIX: V63 → V64 */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
              <h2 className="font-semibold text-white mb-4 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block animate-pulse" />
                System Status
              </h2>
              <div className="grid sm:grid-cols-3 gap-3 text-sm">
                {SYSTEMS.map((s) => (
                  <div key={s} className="flex items-center justify-between bg-gray-800 rounded-xl px-4 py-3">
                    <span className="text-gray-400">{s}</span>
                    <span className="text-green-400 font-medium text-xs">Online</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        );
      }}
    </DashboardShell>
  );
}
