'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { products as productsApi, Product, Paginated } from '@/lib/api';
import DashboardShell from '@/components/DashboardShell';

const STATUS_COLORS: Record<string, string> = {
  active:   'text-green-400 bg-green-900/30',
  draft:    'text-yellow-400 bg-yellow-900/30',
  archived: 'text-gray-400 bg-gray-800',
  pending:  'text-blue-400 bg-blue-900/30',
};

export default function ProductsPage() {
  const [data, setData]       = useState<Paginated<Product> | null>(null);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(true);

  const load = (p: number) => {
    setLoading(true);
    productsApi.list(p, 20)
      .then((d) => { setData(d); setPage(p); })
      .catch(() => toast.error('Failed to load products'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(1); }, []);

  return (
    <DashboardShell>
      {() => (
        <>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-white">Products</h1>
              <p className="text-gray-400 text-sm mt-1">
                {data ? `${data.total} products` : 'Loading…'}
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
                <p className="text-4xl mb-3">🛍️</p>
                <p className="font-medium text-white mb-1">No products yet</p>
                <p className="text-sm">Connect your Shopify store to sync products.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400 text-left">
                    <th className="px-6 py-3 font-medium">Product</th>
                    <th className="px-6 py-3 font-medium">Price</th>
                    <th className="px-6 py-3 font-medium">Score</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 font-medium">Listed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {data.data.map((p) => (
                    <tr key={p.id} className="hover:bg-gray-800/50 transition-colors">
                      <td className="px-6 py-4 text-white font-medium">{p.title}</td>
                      <td className="px-6 py-4 text-gray-300">
                        {p.currency} {p.price.toFixed(2)}
                      </td>
                      <td className="px-6 py-4">
                        {p.score != null ? (
                          <span className={`font-semibold ${p.score >= 7 ? 'text-green-400' : p.score >= 4 ? 'text-yellow-400' : 'text-red-400'}`}>
                            {p.score.toFixed(1)}
                          </span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`text-xs font-medium px-2 py-1 rounded-full ${STATUS_COLORS[p.status] ?? 'text-gray-400 bg-gray-800'}`}>
                          {p.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-gray-500">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {data && data.total > 20 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-gray-500 text-sm">
                Page {page} of {Math.ceil(data.total / 20)}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => load(page - 1)}
                  disabled={page <= 1 || loading}
                  className="px-4 py-2 text-sm bg-gray-900 border border-gray-700 rounded-lg text-gray-300 hover:border-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Previous
                </button>
                <button
                  onClick={() => load(page + 1)}
                  disabled={page >= Math.ceil(data.total / 20) || loading}
                  className="px-4 py-2 text-sm bg-gray-900 border border-gray-700 rounded-lg text-gray-300 hover:border-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
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
