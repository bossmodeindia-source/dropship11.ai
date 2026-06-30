'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import DashboardShell from '@/components/DashboardShell';
import {
  aiProviders,
  userAiConnections,
  AiProvider,
  UserAiConnection,
  UserAiProviderPreference,
} from '@/lib/api';

function featureList(provider: AiProvider) {
  const features = provider.features ?? {};
  return Object.entries(features)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key.replace(/([A-Z])/g, ' $1').toLowerCase());
}

export default function AiSettingsPage() {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [connections, setConnections] = useState<UserAiConnection[]>([]);
  const [preferences, setPreferences] = useState<UserAiProviderPreference[]>([]);
  const [usage, setUsage] = useState<any>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const connectionByProvider = useMemo(
    () => new Map(connections.map(connection => [connection.providerId, connection])),
    [connections],
  );

  const preferenceByCategory = useMemo(
    () => new Map(preferences.map(preference => [preference.category, preference])),
    [preferences],
  );

  const load = async () => {
    setLoading(true);
    try {
      const [available, connected, preferenceRows, usageRows] = await Promise.all([
        aiProviders.available(),
        userAiConnections.list(),
        userAiConnections.preferences().catch(() => []),
        userAiConnections.analytics().catch(() => null),
      ]);
      setProviders(available);
      setConnections(connected);
      setPreferences(preferenceRows);
      setUsage(usageRows);
    } catch {
      toast.error('Failed to load AI settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const connect = async (provider: AiProvider) => {
    const apiKey = keys[provider.id]?.trim();
    if (!apiKey) {
      toast.error('Enter your API key first');
      return;
    }
    try {
      await userAiConnections.connect(provider.id, apiKey);
      setKeys({ ...keys, [provider.id]: '' });
      toast.success(`${provider.displayName} connected`);
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const disconnect = async (connection: UserAiConnection) => {
    await userAiConnections.disconnect(connection.id);
    toast.success('Provider disconnected');
    load();
  };

  const setDefaultProvider = async (provider: AiProvider, useByok: boolean) => {
    try {
      await userAiConnections.setPreference(
        provider.category,
        provider.id,
        provider.defaultModel ?? provider.supportedModels?.[0],
        useByok,
      );
      toast.success(`${provider.displayName} selected for ${provider.category}`);
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const testConnection = async (connection: UserAiConnection) => {
    try {
      const result = await userAiConnections.healthCheck(connection.id);
      toast.success(`Health: ${result.status}${result.latencyMs ? ` (${result.latencyMs}ms)` : ''}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <DashboardShell>
      {() => (
        <>
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-white">AI Settings</h1>
            <p className="text-gray-400 text-sm mt-1">
              Enabled providers are controlled by admins. Platform keys stay hidden; BYOK is optional when allowed.
            </p>
          </div>

          {usage && (
            <div className="grid sm:grid-cols-3 gap-4 mb-6">
              <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
                <p className="text-gray-500 text-xs">AI requests</p>
                <p className="text-2xl text-white font-semibold">{usage.totalRequests ?? usage.total_requests ?? 0}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
                <p className="text-gray-500 text-xs">Tokens used</p>
                <p className="text-2xl text-white font-semibold">{usage.totalTokens ?? usage.total_tokens ?? 0}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
                <p className="text-gray-500 text-xs">Estimated cost</p>
                <p className="text-2xl text-white font-semibold">${Number(usage.totalCostUsd ?? usage.total_cost_usd ?? 0).toFixed(4)}</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="grid sm:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 h-40 animate-pulse" />
              ))}
            </div>
          ) : providers.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
              <p className="text-4xl mb-3">🤖</p>
              <h2 className="font-semibold text-white">No AI providers enabled</h2>
              <p className="text-gray-500 text-sm mt-1">Ask an admin to enable providers from Admin → AI Providers.</p>
            </div>
          ) : (
            <div className="grid lg:grid-cols-2 gap-4">
              {providers.map(provider => {
                const connection = connectionByProvider.get(provider.id);
                const preference = preferenceByCategory.get(provider.category);
                const selected = preference?.providerId === provider.id;
                const features = featureList(provider);
                return (
                  <div key={provider.id} className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
                    <div className="flex items-start gap-4">
                      {provider.logoUrl ? (
                        <img src={provider.logoUrl} alt="" className="w-12 h-12 rounded-xl object-cover bg-gray-800" />
                      ) : (
                        <div className="w-12 h-12 rounded-xl bg-indigo-600/20 text-indigo-300 flex items-center justify-center">
                          AI
                        </div>
                      )}
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className="font-semibold text-white">{provider.displayName}</h2>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-300">
                            {provider.providerType ?? provider.category}
                          </span>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            connection ? 'bg-green-900/30 text-green-400' : 'bg-indigo-900/30 text-indigo-300'
                          }`}>
                            {connection ? 'Using my key' : 'Platform key'}
                          </span>
                          {selected && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-300">
                              Selected default
                            </span>
                          )}
                        </div>
                        <p className="text-gray-500 text-sm mt-1">{provider.description ?? 'Admin-enabled AI provider'}</p>
                      </div>
                    </div>

                    <div className="mt-4 grid sm:grid-cols-2 gap-3 text-sm">
                      <div className="bg-gray-950 border border-gray-800 rounded-xl p-3">
                        <p className="text-gray-500 text-xs mb-1">Available models</p>
                        <p className="text-gray-300">
                          {provider.supportedModels?.length
                            ? provider.supportedModels.join(', ')
                            : provider.defaultModel ?? 'Configured by admin'}
                        </p>
                      </div>
                      <div className="bg-gray-950 border border-gray-800 rounded-xl p-3">
                        <p className="text-gray-500 text-xs mb-1">Status</p>
                        <p className="text-gray-300">{provider.status ?? 'available'}</p>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        onClick={() => setDefaultProvider(provider, false)}
                        className="text-sm border border-gray-700 rounded-lg px-3 py-2 text-gray-200 hover:border-indigo-500"
                      >
                        Use Platform API Key
                      </button>
                      {connection && (
                        <button
                          onClick={() => setDefaultProvider(provider, true)}
                          className="text-sm border border-green-800 text-green-300 rounded-lg px-3 py-2"
                        >
                          Use My API Key
                        </button>
                      )}
                    </div>

                    {features.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-4">
                        {features.map(feature => (
                          <span key={feature} className="text-xs bg-gray-800 text-gray-300 rounded-full px-2 py-1">
                            {feature}
                          </span>
                        ))}
                      </div>
                    )}

                    {provider.byokEnabled ? (
                      <div className="mt-5 border-t border-gray-800 pt-4">
                        <p className="text-gray-400 text-sm mb-3">
                          Use Platform API Key by default, or enter your own encrypted key for this provider.
                        </p>
                        {connection ? (
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-green-400 text-sm font-medium">Your API key is connected</p>
                              <p className="text-gray-500 text-xs">Requests: {connection.totalRequests} · Tokens: {connection.totalTokens}</p>
                            </div>
                            <button onClick={() => disconnect(connection)}
                              className="text-sm border border-red-800 text-red-400 rounded-lg px-3 py-2">
                              Remove my key
                            </button>
                            <button onClick={() => testConnection(connection)}
                              className="text-sm border border-gray-700 text-gray-200 rounded-lg px-3 py-2">
                              Test my key
                            </button>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <input
                              type="password"
                              className="flex-1 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm"
                              placeholder={`Optional ${provider.displayName} API key`}
                              value={keys[provider.id] ?? ''}
                              onChange={e => setKeys({ ...keys, [provider.id]: e.target.value })}
                            />
                            <button onClick={() => connect(provider)}
                              className="bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg px-3 py-2 text-sm font-medium">
                              Use my key
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="mt-5 border-t border-gray-800 pt-4">
                        <p className="text-gray-500 text-sm">BYOK is disabled by admin. This provider uses platform-managed keys only.</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </DashboardShell>
  );
}
