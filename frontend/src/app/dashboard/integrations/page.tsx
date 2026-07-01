'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import DashboardShell from '@/components/DashboardShell';
import {
  integrations as legacyIntegrations,
  Integration,
  userWebsiteConnections,
  websitePlatforms,
  UserPlatformConnection,
  WebsitePlatform,
  WebsitePlatformField,
} from '@/lib/api';

function fieldKey(field: WebsitePlatformField) {
  return String(field.key ?? field.name ?? '').trim();
}

function platformLabel(slug: string) {
  return slug.split(/[-_]/g).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function legacyIntegrationToPlatform(integration: Integration): WebsitePlatform {
  return {
    id: `legacy-${integration.platform}`,
    name: platformLabel(integration.platform),
    slug: integration.platform,
    description: 'Existing commerce integration contract',
    category: 'ecommerce',
    authType: 'api_key',
    requiredFields: [
      { key: 'shop', label: 'Store domain', type: 'text', required: true },
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
    ],
    supportedFeatures: { productSync: true, orderSync: true, inventorySync: true },
    enabled: true,
    maintenanceMode: false,
    isDefault: integration.platform === 'shopify',
    priority: 100,
    fallbackPriority: 100,
  };
}

function legacyIntegrationToConnection(integration: Integration): UserPlatformConnection | null {
  if (!integration.connected) return null;
  return {
    id: `legacy-${integration.platform}`,
    tenantId: 'current',
    platformId: `legacy-${integration.platform}`,
    platformSlug: integration.platform,
    platformName: platformLabel(integration.platform),
    accountLabel: integration.shopName ?? integration.adAccountId ?? null,
    connectionStatus: 'active',
    isActive: true,
    lastValidatedAt: integration.lastSync ?? null,
    createdAt: integration.lastSync ?? new Date().toISOString(),
    updatedAt: integration.lastSync ?? new Date().toISOString(),
  };
}

function PlatformCard({
  platform,
  connection,
  onConnected,
}: {
  platform: WebsitePlatform;
  connection?: UserPlatformConnection;
  onConnected: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accountLabel, setAccountLabel] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});

  const fields = platform.requiredFields?.length
    ? platform.requiredFields
    : [{ key: 'websiteUrl', label: 'Website URL', type: 'url', required: true }];

  const connect = async () => {
    setSaving(true);
    try {
      await userWebsiteConnections.connect({
        platformSlug: platform.slug,
        accountLabel: accountLabel || platform.name,
        credentials,
      });
      toast.success(`${platform.name} connected`);
      setOpen(false);
      onConnected();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-xl bg-gray-800 flex items-center justify-center overflow-hidden text-xl">
          {platform.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={platform.logoUrl} alt={`${platform.name} logo`} className="w-full h-full object-cover" />
          ) : (
            <span>{platform.category === 'marketplace' ? 'M' : platform.category === 'custom_website' ? 'W' : 'S'}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-white">{platform.name}</h3>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              connection ? 'text-green-400 bg-green-900/30' : 'text-gray-500 bg-gray-800'
            }`}>
              {connection ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <p className="text-gray-500 text-sm">
            {platform.description || `${platform.category.replace('_', ' ')} platform managed by your admin`}
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            {Object.entries(platform.supportedFeatures ?? {})
              .filter(([, enabled]) => enabled)
              .slice(0, 5)
              .map(([feature]) => (
                <span key={feature} className="text-xs px-2 py-1 rounded-full bg-indigo-500/10 text-indigo-300">
                  {feature.replace(/([A-Z])/g, ' $1')}
                </span>
              ))}
          </div>
          {connection?.accountLabel && (
            <p className="text-indigo-400 text-xs mt-2">{connection.accountLabel}</p>
          )}
          {connection?.lastValidatedAt && (
            <p className="text-gray-600 text-xs mt-1">
              Last validated: {new Date(connection.lastValidatedAt).toLocaleString()}
            </p>
          )}
        </div>
        <button
          onClick={() => setOpen(value => !value)}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
        >
          {connection ? 'Update' : 'Connect'}
        </button>
      </div>

      {open && (
        <div className="mt-5 border-t border-gray-800 pt-5 space-y-3">
          <input
            className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm"
            placeholder={`${platform.name} account label`}
            value={accountLabel}
            onChange={e => setAccountLabel(e.target.value)}
          />
          <div className="grid md:grid-cols-2 gap-3">
            {fields.map((field) => {
              const key = fieldKey(field);
              if (!key) return null;
              return (
                <label key={key} className="block">
                  <span className="block text-xs text-gray-400 mb-1">
                    {field.label ?? key}{field.required === false ? '' : ' *'}
                  </span>
                  <input
                    className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm"
                    type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
                    value={credentials[key] ?? ''}
                    onChange={e => setCredentials({ ...credentials, [key]: e.target.value })}
                  />
                </label>
              );
            })}
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">Secrets are encrypted and never returned to the browser.</p>
            <button
              disabled={saving}
              onClick={connect}
              className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-medium"
            >
              {saving ? 'Saving...' : 'Save connection'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function IntegrationsPage() {
  const [platforms, setPlatforms] = useState<WebsitePlatform[]>([]);
  const [connections, setConnections] = useState<UserPlatformConnection[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.allSettled([
      websitePlatforms.available(),
      userWebsiteConnections.list(),
      legacyIntegrations.status(),
    ])
      .then(([platformResult, connectionResult, legacyResult]) => {
        const platformRows = platformResult.status === 'fulfilled' ? platformResult.value : [];
        const connectionRows = connectionResult.status === 'fulfilled' ? connectionResult.value : [];
        if (platformRows.length > 0) {
          setPlatforms(platformRows);
          setConnections(connectionRows);
          return;
        }

        const legacyRows = legacyResult.status === 'fulfilled' ? legacyResult.value : [];
        setPlatforms(legacyRows.map(legacyIntegrationToPlatform));
        setConnections(legacyRows.map(legacyIntegrationToConnection).filter(Boolean) as UserPlatformConnection[]);
      })
      .catch(() => toast.error('Failed to load integrations'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const connectionBySlug = useMemo(() => {
    const map = new Map<string, UserPlatformConnection>();
    for (const connection of connections) map.set(connection.platformSlug, connection);
    return map;
  }, [connections]);

  return (
    <DashboardShell>
      {() => (
        <>
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-white">Integrations</h1>
            <p className="text-gray-400 text-sm mt-1">
              Website Integrations are enabled by your admin and rendered from database-driven platform configuration.
            </p>
          </div>

          {loading ? (
            <div className="grid sm:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 animate-pulse h-32" />
              ))}
            </div>
          ) : platforms.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-10 text-center">
              <p className="text-4xl mb-3">🔌</p>
              <h2 className="text-white font-semibold mb-1">No website platforms enabled</h2>
              <p className="text-gray-500 text-sm">Ask an admin to enable Shopify, WooCommerce, Custom Website, or another platform.</p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-4">
              {platforms.map(platform => (
                <PlatformCard
                  key={platform.id}
                  platform={platform}
                  connection={connectionBySlug.get(platform.slug)}
                  onConnected={load}
                />
              ))}
            </div>
          )}
        </>
      )}
    </DashboardShell>
  );
}
