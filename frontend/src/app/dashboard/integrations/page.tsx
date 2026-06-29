'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { integrations as intApi, Integration } from '@/lib/api';
import DashboardShell from '@/components/DashboardShell';

const PLATFORM_META: Record<string, { icon: string; label: string; description: string }> = {
  shopify: { icon: '🛒', label: 'Shopify',   description: 'Sync products, orders, and inventory' },
  meta:    { icon: '📘', label: 'Meta Ads',  description: 'Facebook & Instagram ad campaigns' },
  tiktok:  { icon: '🎵', label: 'TikTok Ads', description: 'TikTok for Business ad campaigns' },
  google:  { icon: '🔍', label: 'Google Ads', description: 'Google Shopping & Search campaigns' },
  telegram:{ icon: '✈️', label: 'Telegram',  description: 'AI bot pool & CDN media storage' },
};

function IntegrationCard({ integration }: { integration: Integration }) {
  const meta = PLATFORM_META[integration.platform.toLowerCase()] ?? {
    icon: '🔗',
    label: integration.platform,
    description: 'Third-party integration',
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex items-start gap-4">
      <div className="text-3xl">{meta.icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="font-semibold text-white">{meta.label}</h3>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            integration.connected
              ? 'text-green-400 bg-green-900/30'
              : 'text-gray-500 bg-gray-800'
          }`}>
            {integration.connected ? 'Connected' : 'Not connected'}
          </span>
        </div>
        <p className="text-gray-500 text-sm">{meta.description}</p>
        {integration.connected && integration.shopName && (
          <p className="text-indigo-400 text-xs mt-1">{integration.shopName}</p>
        )}
        {integration.connected && integration.lastSync && (
          <p className="text-gray-600 text-xs mt-1">
            Last sync: {new Date(integration.lastSync).toLocaleString()}
          </p>
        )}
      </div>
      <div>
        {integration.connected ? (
          <button className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-red-600 hover:text-red-400 transition-colors">
            Disconnect
          </button>
        ) : (
          <button className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors">
            Connect
          </button>
        )}
      </div>
    </div>
  );
}

export default function IntegrationsPage() {
  const [data, setData]       = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    intApi.status()
      .then(setData)
      .catch(() => toast.error('Failed to load integrations'))
      .finally(() => setLoading(false));
  }, []);

  // Fallback list when backend returns empty (before any integrations configured)
  const displayList: Integration[] = data.length > 0
    ? data
    : ['shopify', 'meta', 'tiktok', 'google', 'telegram'].map((p) => ({
        platform: p,
        connected: false,
      }));

  return (
    <DashboardShell>
      {() => (
        <>
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-white">Integrations</h1>
            <p className="text-gray-400 text-sm mt-1">Connect your commerce and advertising platforms</p>
          </div>

          {loading ? (
            <div className="grid sm:grid-cols-2 gap-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 animate-pulse h-24" />
              ))}
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-4">
              {displayList.map((int) => (
                <IntegrationCard key={int.platform} integration={int} />
              ))}
            </div>
          )}
        </>
      )}
    </DashboardShell>
  );
}
