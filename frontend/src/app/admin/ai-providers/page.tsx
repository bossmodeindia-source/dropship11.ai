'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { adminApi, AiProvider, CreateAiProviderDto } from '@/lib/api';

const CATEGORIES = [
  ['reasoning', 'Chat'],
  ['image_generation', 'Image'],
  ['video_generation', 'Video'],
  ['voice', 'Audio'],
  ['embedding', 'Embedding'],
  ['multimodal', 'Vision'],
] as const;

const blankForm: CreateAiProviderDto = {
  providerKey: '',
  displayName: '',
  category: 'reasoning',
  providerType: 'chat',
  apiBaseUrl: '',
  endpointPath: '/chat/completions',
  authHeaderName: 'Authorization',
  authHeaderTemplate: 'Bearer {{apiKey}}',
  defaultModel: '',
  supportedModels: [],
  priority: 100,
  fallbackPriority: 100,
  enabled: true,
  byokEnabled: true,
  supportsStreaming: true,
  supportsJsonMode: true,
};

function maskKey(configured?: boolean) {
  return configured ? '•••••••• configured' : 'No platform key';
}

export default function AdminAiProvidersPage() {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<CreateAiProviderDto>(blankForm);
  const [modelsText, setModelsText] = useState('');
  const [presets, setPresets] = useState<CreateAiProviderDto[]>([]);
  const [analytics, setAnalytics] = useState<any[]>([]);

  const enabledCount = useMemo(
    () => providers.filter(p => p.status === 'approved' && p.enabled !== false).length,
    [providers],
  );

  const load = () => {
    setLoading(true);
    Promise.all([
      adminApi.aiProviders(),
      adminApi.aiProviderPresets().catch(() => []),
      adminApi.aiProviderAnalytics().catch(() => []),
    ])
      .then(([providerRows, presetRows, analyticsRows]) => {
        setProviders(providerRows);
        setPresets(presetRows);
        setAnalytics(Array.isArray(analyticsRows) ? analyticsRows : []);
      })
      .catch(() => toast.error('Failed to load AI providers'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const submit = async () => {
    setSaving(true);
    try {
      const dto = {
        ...form,
        providerKey: form.providerKey.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        supportedModels: modelsText.split(',').map(m => m.trim()).filter(Boolean),
        modelList: modelsText.split(',').map(m => m.trim()).filter(Boolean),
      };
      await adminApi.createAiProvider(dto);
      toast.success('Provider created. Approve it to publish to users.');
      setForm(blankForm);
      setModelsText('');
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const update = async (provider: AiProvider, dto: Partial<CreateAiProviderDto>) => {
    try {
      await adminApi.updateAiProvider(provider.id, dto);
      toast.success('Provider updated');
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const applyPreset = (providerKey: string) => {
    const preset = presets.find(item => item.providerKey === providerKey);
    if (!preset) return;
    setForm({ ...blankForm, ...preset, apiKey: '', enabled: true });
    setModelsText((preset.supportedModels ?? preset.modelList ?? []).join(', '));
  };

  const exportConfig = async () => {
    const data = await adminApi.exportAiProviders();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-providers-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 bg-gray-900/60 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="text-gray-400 hover:text-white text-sm">← Admin Panel</Link>
            <span className="text-gray-700">/</span>
            <h1 className="font-bold">AI Providers</h1>
          </div>
          <button onClick={exportConfig} className="text-sm border border-gray-700 rounded-lg px-3 py-2 text-gray-300 hover:border-indigo-500">
            Export config
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid md:grid-cols-3 gap-4 mb-8">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <p className="text-gray-400 text-sm">Enabled providers</p>
            <p className="text-3xl font-bold text-green-400">{enabledCount}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <p className="text-gray-400 text-sm">Catalog entries</p>
            <p className="text-3xl font-bold text-indigo-400">{providers.length}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <p className="text-gray-400 text-sm">Routing mode</p>
            <p className="text-xl font-bold text-amber-400">Database-driven</p>
          </div>
        </div>

        <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-8">
          <h2 className="font-semibold mb-4">Add any AI provider</h2>
          {presets.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <span className="text-sm text-gray-400">Low-cost presets:</span>
              <select
                className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm"
                defaultValue=""
                onChange={e => applyPreset(e.target.value)}
              >
                <option value="" disabled>Prefill provider settings</option>
                {presets.map(preset => (
                  <option key={preset.providerKey} value={preset.providerKey}>{preset.displayName}</option>
                ))}
              </select>
              <span className="text-xs text-gray-500">Presets never include API keys.</span>
            </div>
          )}
          <div className="grid md:grid-cols-3 gap-3">
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Provider slug, e.g. acme-ai"
              value={form.providerKey} onChange={e => setForm({ ...form, providerKey: e.target.value })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Provider name"
              value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} />
            <select className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2"
              value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Logo URL"
              value={form.logoUrl ?? ''} onChange={e => setForm({ ...form, logoUrl: e.target.value })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Base API URL"
              value={form.apiBaseUrl ?? ''} onChange={e => setForm({ ...form, apiBaseUrl: e.target.value, baseUrl: e.target.value })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Endpoint path"
              value={form.endpointPath ?? ''} onChange={e => setForm({ ...form, endpointPath: e.target.value })} />
            <select className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2"
              value={form.authType ?? 'bearer'} onChange={e => setForm({ ...form, authType: e.target.value as CreateAiProviderDto['authType'] })}>
              <option value="bearer">Bearer token</option>
              <option value="x-api-key">x-api-key/header</option>
              <option value="query-param">Query param</option>
              <option value="none">No auth</option>
            </select>
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Query param name, e.g. key"
              value={form.queryParamName ?? ''} onChange={e => setForm({ ...form, queryParamName: e.target.value })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Platform API key (encrypted)"
              type="password" value={form.apiKey ?? ''} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Default model"
              value={form.defaultModel ?? ''} onChange={e => setForm({ ...form, defaultModel: e.target.value })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Models comma separated"
              value={modelsText} onChange={e => setModelsText(e.target.value)} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Cost per 1K tokens"
              type="number" value={form.costPer1KTokens ?? ''} onChange={e => setForm({ ...form, costPer1KTokens: Number(e.target.value) })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="RPM"
              type="number" value={form.requestsPerMinute ?? ''} onChange={e => setForm({ ...form, requestsPerMinute: Number(e.target.value) })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Daily budget"
              type="number" value={form.dailyBudget ?? ''} onChange={e => setForm({ ...form, dailyBudget: Number(e.target.value) })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Daily request limit"
              type="number" value={form.dailyRequestLimit ?? ''} onChange={e => setForm({ ...form, dailyRequestLimit: Number(e.target.value) })} />
            <input className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2" placeholder="Monthly request limit"
              type="number" value={form.monthlyRequestLimit ?? ''} onChange={e => setForm({ ...form, monthlyRequestLimit: Number(e.target.value) })} />
          </div>
          <div className="flex flex-wrap gap-4 mt-4 text-sm text-gray-300">
            {[
              ['enabled', 'Enabled'],
              ['byokEnabled', 'Allow BYOK'],
              ['supportsStreaming', 'Streaming'],
              ['supportsVision', 'Vision'],
              ['supportsImageGeneration', 'Image generation'],
              ['supportsFunctionCalling', 'Function calling'],
              ['supportsJsonMode', 'JSON mode'],
              ['isDefault', 'Default provider'],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input type="checkbox" checked={Boolean((form as any)[key])}
                  onChange={e => setForm({ ...form, [key]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
          <button disabled={saving} onClick={submit}
            className="mt-5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg px-4 py-2 font-medium">
            {saving ? 'Saving…' : 'Create provider'}
          </button>
        </section>

        {analytics.length > 0 && (
          <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-8">
            <h2 className="font-semibold mb-4">Usage and cost analytics</h2>
            <div className="grid md:grid-cols-3 gap-3">
              {analytics.slice(0, 6).map(row => (
                <div key={row.providerKey ?? row.provider_id} className="bg-gray-950 border border-gray-800 rounded-xl p-4">
                  <p className="text-white font-medium">{row.displayName ?? row.providerKey ?? 'Provider'}</p>
                  <p className="text-gray-400 text-sm">Requests: {row.totalRequests ?? row.total_requests ?? 0}</p>
                  <p className="text-gray-400 text-sm">Cost: ${Number(row.totalCostUsd ?? row.total_cost_usd ?? 0).toFixed(4)}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
            <h2 className="font-semibold">Provider catalog</h2>
            <span className="text-xs text-gray-500">Fallback order follows priority → fallback priority</span>
          </div>
          {loading ? (
            <div className="p-8 text-gray-400">Loading providers…</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-gray-400 border-b border-gray-800">
                  <tr>
                    <th className="text-left px-6 py-3">Provider</th>
                    <th className="text-left px-6 py-3">Models</th>
                    <th className="text-left px-6 py-3">Key</th>
                    <th className="text-left px-6 py-3">Priority</th>
                    <th className="text-left px-6 py-3">Health</th>
                    <th className="text-left px-6 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {providers.map(provider => (
                    <tr key={provider.id}>
                      <td className="px-6 py-4">
                        <p className="font-medium">{provider.displayName}</p>
                        {provider.isDefault && <p className="text-amber-400 text-xs mt-1">Default provider</p>}
                        <p className="text-gray-500">{provider.providerKey} · {provider.category}</p>
                      </td>
                      <td className="px-6 py-4 text-gray-400 max-w-xs truncate">
                        {provider.defaultModel ?? provider.supportedModels?.join(', ') ?? '—'}
                      </td>
                      <td className="px-6 py-4 text-gray-400">{maskKey(provider.apiKeyConfigured)}</td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2">
                          <input className="w-20 bg-gray-950 border border-gray-800 rounded px-2 py-1" type="number"
                            defaultValue={provider.priority ?? 100}
                            onBlur={e => update(provider, { priority: Number(e.target.value) })} />
                          <input className="w-20 bg-gray-950 border border-gray-800 rounded px-2 py-1" type="number"
                            defaultValue={provider.fallbackPriority ?? 100}
                            onBlur={e => update(provider, { fallbackPriority: Number(e.target.value) })} />
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-xs px-2 py-1 rounded-full bg-gray-800 text-gray-300">
                          {provider.healthStatus ?? provider.status ?? 'unknown'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-2">
                          {provider.status !== 'approved' && (
                            <button onClick={() => adminApi.approveAiProvider(provider.id).then(load)}
                              className="text-xs bg-green-600 rounded px-2 py-1">Approve</button>
                          )}
                          <button onClick={() => update(provider, { enabled: provider.enabled === false })}
                            className="text-xs border border-gray-700 rounded px-2 py-1">
                            {provider.enabled === false ? 'Enable' : 'Disable'}
                          </button>
                          <button onClick={() => adminApi.testAiProvider(provider.id).then(r => toast.success(`Health: ${r.status}`)).catch(e => toast.error(e.message))}
                            className="text-xs border border-gray-700 rounded px-2 py-1">Test</button>
                          <button onClick={() => adminApi.setDefaultAiProvider(provider.id).then(load).then(() => toast.success('Default provider updated'))}
                            className="text-xs border border-amber-700 text-amber-300 rounded px-2 py-1">Set default</button>
                          <button onClick={() => adminApi.deleteAiProvider(provider.id).then(load)}
                            className="text-xs border border-red-800 text-red-400 rounded px-2 py-1">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
