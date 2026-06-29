'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { analytics as analyticsApi, AnalyticsSnapshot } from '@/lib/api';
import DashboardShell from '@/components/DashboardShell';

const PERIODS = [7, 14, 30] as const;

const MetricCard = ({ label, value, note, trend }: { label: string; value: string; note?: string; trend?: 'up' | 'down' | null }) => (
  <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
    <p className="text-gray-400 text-sm mb-2">{label}</p>
    <div className="flex items-end gap-2">
      <p className="text-3xl font-bold text-white">{value}</p>
      {trend === 'up' && <span className="text-green-400 text-sm mb-0.5">↑</span>}
      {trend === 'down' && <span className="text-red-400 text-sm mb-0.5">↓</span>}
    </div>
    {note && <p className="text-gray-600 text-xs mt-1">{note}</p>}
  </div>
);

export default function AnalyticsPage() {
  const [data, setData]       = useState<AnalyticsSnapshot | null>(null);
  const [period, setPeriod]   = useState<7 | 14 | 30>(7);
  const [loading, setLoading] = useState(true);

  const load = (days: 7 | 14 | 30) => {
    setLoading(true);
    analyticsApi.snapshot(days)
      .then(setData)
      .catch(() => toast.error('Failed to load analytics'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(7); }, []);

  const fmt = (n: number | null, prefix = '') =>
    n == null ? '—' : `${prefix}${n.toFixed(2)}`;

  return (
    <DashboardShell>
      {() => (
        <>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-white">Analytics</h1>
              <p className="text-gray-400 text-sm mt-1">Commerce performance metrics</p>
            </div>
            <div className="flex bg-gray-900 border border-gray-800 rounded-xl p-1 gap-1">
              {PERIODS.map((d) => (
                <button
                  key={d}
                  onClick={() => { setPeriod(d); load(d); }}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${period === d ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 animate-pulse">
                  <div className="h-3 bg-gray-700 rounded w-20 mb-3" />
                  <div className="h-8 bg-gray-700 rounded w-24" />
                </div>
              ))}
            </div>
          ) : data ? (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <MetricCard label="Revenue"         value={`${data.currency} ${data.revenueTotal.toLocaleString()}`} note={`Last ${data.periodDays} days`} />
              <MetricCard label="Ad Spend"        value={`${data.currency} ${data.adSpend.toLocaleString()}`}     note={`Last ${data.periodDays} days`} />
              <MetricCard label="ROAS"            value={data.roas != null ? `${data.roas.toFixed(2)}×` : '—'}   note="Return on ad spend" trend={data.roas != null && data.roas >= 2 ? 'up' : 'down'} />
              <MetricCard label="CAC"             value={fmt(data.cac, data.currency + ' ')}                      note="Cost to acquire customer" />
              <MetricCard label="LTV"             value={fmt(data.ltv, data.currency + ' ')}                      note="Customer lifetime value" />
              <MetricCard label="Conversion Rate" value={data.conversionRate != null ? `${(data.conversionRate * 100).toFixed(2)}%` : '—'} note="Visitors → Buyers" />
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-12 text-center text-gray-500">
              <p className="text-4xl mb-3">📊</p>
              <p className="font-medium text-white mb-1">No analytics data yet</p>
              <p className="text-sm">Data will populate after your first orders come in.</p>
            </div>
          )}
        </>
      )}
    </DashboardShell>
  );
}
