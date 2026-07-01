'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { adminApi, CreateWebsitePlatformDto, WebsitePlatform } from '@/lib/api';

const blankForm: CreateWebsitePlatformDto = {
  name: '',
  slug: '',
  category: 'ecommerce',
  authType: 'api_key',
  apiBaseUrl: '',
  requiredFields: [
    { key: 'websiteUrl', label: 'Website URL', type: 'url', required: true },
    { key: 'apiKey', label: 'API Key', type: 'password', required: true },
  ],
  supportedFeatures: {
    productSync: true,
    orderSync: true,
    inventorySync: true,
    webhooks: true,
  },
  enabled: true,
  maintenanceMode: false,
  isDefault: false,
  priority: 100,
  fallbackPriority: 100,
};

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export default function AdminWebsitePlatformsPage() {
  const [platforms, setPlatforms] = useState<WebsitePlatform[]>([]);
  const [presets, setPresets] = useState<Array<CreateWebsitePlatformDto & { presetKey?: string }>>([]);
  const [analytics, setAnalytics] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CreateWebsitePlatformDto>(blankForm);
  const [requiredFieldsText, setRequiredFieldsText] = useState(JSON.stringify(blankForm.requiredFields, null, 2));
  const [featuresText, setFeaturesText] = useState(JSON.stringify(blankForm.supportedFeatures, null, 2));

  const enabledCount = useMemo(() => platforms.filter(platform => platform.enabled && !platform.maintenanceMode).length, [platforms]);

  const load = () => {
    setLoading(true);
    Promise.all([
      adminApi.websitePlatforms(),
      adminApi.websitePlatformPresets().catch(() => []),
      adminApi.websitePlatformAnalytics().catch(() => []),
    ])
      .then(([platformRows, presetRows, analyticsRows]) => {
        setPlatforms(platformRows);
        setPresets(presetRows);
        setAnalytics(Array.isArray(analyticsRows) ? analyticsRows : []);
      })
      .catch(() => toast.error('Failed to load website platforms'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const resetForm = () => {
    setEditingId(null);
    setForm(blankForm);
    setRequiredFieldsText(JSON.stringify(blankForm.requiredFields, null, 2));
    setFeaturesText(JSON.stringify(blankForm.supportedFeatures, null, 2));
  };

  const edit = (platform: WebsitePlatform) => {
    setEditingId(platform.id);
    const dto: CreateWebsitePlatformDto = {
      name: platform.name,
      slug: platform.slug,
      logoUrl: platform.logoUrl ?? '',
      description: platform.description ?? '',
      category: platform.category as CreateWebsitePlatformDto['category'],
      authType: platform.authType as CreateWebsitePlatformDto['authType'],
      apiBaseUrl: platform.apiBaseUrl ?? '',
      oauthUrl: platform.oauthUrl ?? '',
      tokenUrl: platform.tokenUrl ?? '',
      redirectUrl: platform.redirectUrl ?? '',
      scopes: platform.scopes ?? [],
      requiredFields: platform.requiredFields ?? [],
      apiVersion: platform.apiVersion ?? '',
      healthEndpoint: platform.healthEndpoint ?? '',
      documentationUrl: platform.documentationUrl ?? '',
      supportedFeatures: platform.supportedFeatures ?? {},
      connectionWizard: platform.connectionWizard ?? {},
      enabled: platform.enabled,
      maintenanceMode: platform.maintenanceMode,
      isDefault: platform.isDefault,
      priority: platform.priority,
      fallbackPriority: platform.fallbackPriority,
    };
    setForm(dto);
    setRequiredFieldsText(JSON.stringify(dto.requiredFields, null, 2));
    setFeaturesText(JSON.stringify(dto.supportedFeatures, null, 2));
  };

  const applyPreset = (slug: string) => {
    const preset = presets.find(item => item.slug === slug || item.presetKey === slug);
    if (!preset) return;
    const dto = { ...blankForm, ...preset, enabled: true };
    setEditingId(null);
    setForm(dto);
    setRequiredFieldsText(JSON.stringify(dto.requiredFields ?? [], null, 2));
    setFeaturesText(JSON.stringify(dto.supportedFeatures ?? {}, null, 2));
  };

  const submit = async () => {
    setSaving(true);
    try {
      const dto: CreateWebsitePlatformDto = {
        ...form,
        slug: slugify(form.slug || form.name),
        requiredFields: parseJson(requiredFieldsText, []),
        supportedFeatures: parseJson(featuresText, {}),
      };
      if (editingId) {
        await adminApi.updateWebsitePlatform(editingId, dto);
        toast.success('Website platform updated');
      } else {
        await adminApi.createWebsitePlatform(dto);
        toast.success('Website platform created');
      }
      resetForm();
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (platform: WebsitePlatform) => {
    try {
      await adminApi.updateWebsitePlatform(platform.id, {
        name: platform.name,
        slug: platform.slug,
        category: platform.category as CreateWebsitePlatformDto['category'],
        authType: platform.authType as CreateWebsitePlatformDto['authType'],
        enabled: !platform.enabled,
      });
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 bg-gray-900/60 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="text-gray-400 hover:text-white text-sm">← Admin Panel</Link>
            <span className="text-gray-700">/</span>
            <h1 className="font-bold">Website Platforms</h1>
          </div>
          <button onClick={resetForm} className="text-sm border border-gray-700 rounded-lg px-3 py-2 text-gray-300 hover:border-indigo-500">
            New platform
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid md:grid-cols-4 gap-4 mb-8">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <p className="text-gray-400 text-sm">Enabled platforms</p>
            <p className="text-3xl font-bold text-green-400">{enabledCount}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <p className="text-gray-400 text-sm">Catalog entries</p>
            <p className="text-3xl font-bold text-indigo-400">{platforms.length}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <p className="text-gray-400 text-sm">Connected stores</p>
            <p className="text-3xl font-bold text-amber-400">{analytics.reduce((sum, row) => sum + Number(row.connected_stores ?? 0), 0)}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <p className="text-gray-400 text-sm">Runtime mode</p>
            <p className="text-lg font-bold text-purple-400">DB-driven</p>
          </div>
        </div>

        <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-8">
          <h2 className="font-semibold mb-4">{editingId ? 'Edit website platform' : 'Add website platform'}</h2>
          {presets.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <span className="text-sm text-gray-400">Presets:</span>
              <select className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm" defaultValue="" onChange={e => applyPreset(e.target.value)}>
                <option value="" disabled>Prefill platform</option>
                {presets.map(preset => <option key={preset.slug} value={preset.slug}>{preset.name}</option>)}
              </select>
              <span className="text-xs text-gray-500">Presets define endpoints and dynamic fields only. Admin secrets stay separate.</span>
            </div>
          )}

          <div className="grid md:grid-cols-3 gap-3">
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Name"
              value={form.name} onChange={e => setForm({ ...form, name: e.target.value, slug: form.slug || slugify(e.target.value) })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Slug"
              value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value })} />
            <select className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2"
              value={form.category} onChange={e => setForm({ ...form, category: e.target.value as CreateWebsitePlatformDto['category'] })}>
              <option value="ecommerce">Ecommerce</option>
              <option value="marketplace">Marketplace</option>
              <option value="cms">CMS</option>
              <option value="erp">ERP</option>
              <option value="pos">POS</option>
              <option value="custom_website">Custom Website</option>
            </select>
            <select className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2"
              value={form.authType} onChange={e => setForm({ ...form, authType: e.target.value as CreateWebsitePlatformDto['authType'] })}>
              <option value="oauth2">OAuth2</option>
              <option value="api_key">API Key</option>
              <option value="bearer_token">Bearer Token</option>
              <option value="jwt">JWT</option>
              <option value="username_password">Username + Password</option>
              <option value="webhook">Webhook</option>
              <option value="custom">Custom</option>
              <option value="none">None</option>
            </select>
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Base API URL"
              value={form.apiBaseUrl ?? ''} onChange={e => setForm({ ...form, apiBaseUrl: e.target.value })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Health endpoint"
              value={form.healthEndpoint ?? ''} onChange={e => setForm({ ...form, healthEndpoint: e.target.value })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Logo URL"
              value={form.logoUrl ?? ''} onChange={e => setForm({ ...form, logoUrl: e.target.value })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Webhook secret (encrypted)"
              type="password" value={form.webhookSecret ?? ''} onChange={e => setForm({ ...form, webhookSecret: e.target.value })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Documentation URL"
              value={form.documentationUrl ?? ''} onChange={e => setForm({ ...form, documentationUrl: e.target.value })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" type="number" placeholder="Priority"
              value={form.priority ?? 100} onChange={e => setForm({ ...form, priority: Number(e.target.value) })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" type="number" placeholder="Fallback priority"
              value={form.fallbackPriority ?? 100} onChange={e => setForm({ ...form, fallbackPriority: Number(e.target.value) })} />
            <textarea className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 md:col-span-3" placeholder="Description"
              value={form.description ?? ''} onChange={e => setForm({ ...form, description: e.target.value })} />
            <label className="md:col-span-3">
              <span className="block text-sm text-gray-400 mb-1">Dynamic connection fields JSON</span>
              <textarea className="w-full h-40 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 font-mono text-xs"
                value={requiredFieldsText} onChange={e => setRequiredFieldsText(e.target.value)} />
            </label>
            <label className="md:col-span-3">
              <span className="block text-sm text-gray-400 mb-1">Supported features JSON</span>
              <textarea className="w-full h-32 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 font-mono text-xs"
                value={featuresText} onChange={e => setFeaturesText(e.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap gap-4 mt-4 text-sm text-gray-300">
            {[
              ['enabled', 'Enabled'],
              ['maintenanceMode', 'Maintenance mode'],
              ['isDefault', 'Default platform'],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input type="checkbox" checked={Boolean((form as any)[key])} onChange={e => setForm({ ...form, [key]: e.target.checked } as CreateWebsitePlatformDto)} />
                {label}
              </label>
            ))}
          </div>
          <button disabled={saving} onClick={submit} className="mt-5 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 font-medium">
            {saving ? 'Saving...' : editingId ? 'Update platform' : 'Create platform'}
          </button>
        </section>

        <section className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
            <h2 className="font-semibold">Platform registry</h2>
            {loading && <span className="text-sm text-gray-500">Loading...</span>}
          </div>
          <div className="divide-y divide-gray-800">
            {platforms.map(platform => (
              <div key={platform.id} className="p-5 flex flex-col md:flex-row md:items-center gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{platform.name}</h3>
                    <span className="text-xs text-gray-500">{platform.slug}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${platform.enabled ? 'bg-green-900/30 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
                      {platform.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    {platform.isDefault && <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-900/30 text-indigo-300">Default</span>}
                  </div>
                  <p className="text-gray-500 text-sm mt-1">{platform.description || platform.apiBaseUrl || 'No description'}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => edit(platform)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:border-indigo-500">Edit</button>
                  <button onClick={() => toggle(platform)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:border-amber-500">
                    {platform.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => adminApi.testWebsitePlatform(platform.id).then(r => toast.success(`Health: ${r.status}`)).catch(e => toast.error(e.message))}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:border-green-500">
                    Test
                  </button>
                  <button onClick={() => adminApi.deleteWebsitePlatform(platform.id).then(load).then(() => toast.success('Platform disabled')).catch(e => toast.error(e.message))}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-red-300 hover:border-red-500">
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {!platforms.length && !loading && (
              <div className="p-10 text-center text-gray-500">
                No website platforms yet. Start with a preset or create a custom one.
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
