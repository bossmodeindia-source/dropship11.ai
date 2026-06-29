'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { campaigns as campaignsApi, Campaign, Paginated } from '@/lib/api';
import DashboardShell from '@/components/DashboardShell';

const STATUS_COLORS: Record<string, string> = {
  active:   'text-green-400 bg-green-900/30',
  paused:   'text-yellow-400 bg-yellow-900/30',
  draft:    'text-gray-400 bg-gray-800',
  ended:    'text-gray-500 bg-gray-800',
  error:    'text-red-400 bg-red-900/30',
};

const PLATFORM_ICONS: Record<string, string> = {
  meta:   '📘',
  tiktok: '🎵',
  google: '🔍',
  other:  '📣',
};

export default function CampaignsPage() {
  const [data, setData]       = useState<Paginated<Campaign> | null>(null);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(true);

  const load = (p: number) => {
    setLoading(true);
    campaignsApi.list(p, 20)
      .then((d) => { setData(d); setPage(p); })
      .catch(() => toast.error('Failed to load campaigns'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(1); }, []);

  return (
    <DashboardShell>
      {() => (
        <>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-white">AI Campaigns</h1>
              <p className="text-gray-400 text-sm mt-1">
                {data ? `${data.total} campaigns` : 'Loading…'}
              </p>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
            {loading ? (
              <div className="p-8 flex justify-center">
                <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : !data?.data.length ? (
              <div className="p-12 text-center text-gray-500">
                <p className="text-4xl mb-3">🤖</p>
                <p className="font-medium text-white mb-1">No campaigns yet</p>
                <p className="text-sm">Connect a Meta or TikTok ad account to launch AI-generated campaigns.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400 text-left">
                    <th className="px-6 py-3 font-medium">Campaign</th>
                    <th className="px-6 py-3 font-medium">Platform</th>
                    <th className="px-6 py-3 font-medium">Budget</th>
                    <th className="px-6 py-3 font-medium">Spent</th>
                    <th className="px-6 py-3 font-medium">ROAS</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {data.data.map((c) => (
                    <tr key={c.id} className="hover:bg-gray-800/50 transition-colors">
                      <td className="px-6 py-4 text-white font-medium">{c.name}</td>
                      <td className="px-6 py-4 text-gray-400">
                        {PLATFORM_ICONS[c.platform.toLowerCase()] ?? '📣'} {c.platform}
                      </td>
                      <td className="px-6 py-4 text-gray-300">{c.currency} {c.budget.toFixed(0)}</td>
                      <td className="px-6 py-4 text-gray-300">{c.currency} {c.spent.toFixed(0)}</td>
                      <td className="px-6 py-4">
                        {c.roas != null ? (
                          <span className={c.roas >= 2 ? 'text-green-400 font-semibold' : 'text-red-400 font-semibold'}>
                            {c.roas.toFixed(2)}×
                          </span>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`text-xs font-medium px-2 py-1 rounded-full ${STATUS_COLORS[c.status] ?? 'text-gray-400 bg-gray-800'}`}>
                          {c.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {data && data.total > 20 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-gray-500 text-sm">Page {page} of {Math.ceil(data.total / 20)}</p>
              <div className="flex gap-2">
                <button onClick={() => load(page - 1)} disabled={page <= 1 || loading}
                  className="px-4 py-2 text-sm bg-gray-900 border border-gray-700 rounded-lg text-gray-300 hover:border-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  Previous
                </button>
                <button onClick={() => load(page + 1)} disabled={page >= Math.ceil(data.total / 20) || loading}
                  className="px-4 py-2 text-sm bg-gray-900 border border-gray-700 rounded-lg text-gray-300 hover:border-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </DashboardShell>
  );
}
