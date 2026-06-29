import { relations } from 'drizzle-orm';
import {
  users,
  refreshTokens,
  subscriptions,
  shopifyApiKeys,
  products,
  orders,
  orderStatusLog,
  campaigns,
  metaAdSets,
  metaAdCreatives,
  auditLogs,
  aiUsageLogs,
  adCreativeAssets,
  adMediaAssets,
  aiJobResults,
  aiMemory,
  campaignMetrics,
} from './schema';

export const usersRelations = relations(users, ({ one, many }) => ({
  subscriptions:    one(subscriptions, { fields: [users.id], references: [subscriptions.userId] }),
  shopifyApiKeys:   one(shopifyApiKeys, { fields: [users.id], references: [shopifyApiKeys.userId] }),
  refreshTokens:    many(refreshTokens),
  products:         many(products),
  orders:           many(orders),
  campaigns:        many(campaigns),
  metaAdSets:       many(metaAdSets),
  metaAdCreatives:  many(metaAdCreatives),
  auditLogs:        many(auditLogs),
  aiUsageLogs:      many(aiUsageLogs),
  adCreativeAssets: many(adCreativeAssets),
  aiJobResults:     many(aiJobResults),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}));

export const shopifyApiKeysRelations = relations(shopifyApiKeys, ({ one }) => ({
  user: one(users, { fields: [shopifyApiKeys.userId], references: [users.id] }),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  user:             one(users, { fields: [products.userId], references: [users.id] }),
  orders:           many(orders),
  campaigns:        many(campaigns),
  metaAdSets:       many(metaAdSets),
  metaAdCreatives:  many(metaAdCreatives),
  adCreativeAssets: many(adCreativeAssets),
  adMediaAssets:    many(adMediaAssets),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user:      one(users,    { fields: [orders.userId],    references: [users.id] }),
  product:   one(products, { fields: [orders.productId], references: [products.id] }),
  statusLog: many(orderStatusLog),
}));

export const orderStatusLogRelations = relations(orderStatusLog, ({ one }) => ({
  order: one(orders, { fields: [orderStatusLog.orderId], references: [orders.id] }),
}));

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  user:             one(users,    { fields: [campaigns.userId],    references: [users.id] }),
  product:          one(products, { fields: [campaigns.productId], references: [products.id] }),
  metaAdSets:       many(metaAdSets),
  metaAdCreatives:  many(metaAdCreatives),
  adCreativeAssets: many(adCreativeAssets),
  adMediaAssets:    many(adMediaAssets),
  aiMemoryPatterns: many(aiMemory),
}));

export const metaAdSetsRelations = relations(metaAdSets, ({ one, many }) => ({
  campaign:  one(campaigns, { fields: [metaAdSets.campaignId], references: [campaigns.id] }),
  user:      one(users,     { fields: [metaAdSets.userId],     references: [users.id] }),
  product:   one(products,  { fields: [metaAdSets.productId],  references: [products.id] }),
  creatives: many(metaAdCreatives),
}));

export const metaAdCreativesRelations = relations(metaAdCreatives, ({ one }) => ({
  adSet:    one(metaAdSets, { fields: [metaAdCreatives.adSetId],    references: [metaAdSets.id] }),
  campaign: one(campaigns,  { fields: [metaAdCreatives.campaignId], references: [campaigns.id] }),
  user:     one(users,      { fields: [metaAdCreatives.userId],     references: [users.id] }),
  product:  one(products,   { fields: [metaAdCreatives.productId],  references: [products.id] }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  user: one(users, { fields: [auditLogs.actorId], references: [users.id] }),
}));

export const aiUsageLogsRelations = relations(aiUsageLogs, ({ one }) => ({
  user: one(users, { fields: [aiUsageLogs.userId], references: [users.id] }),
}));

export const adCreativeAssetsRelations = relations(adCreativeAssets, ({ one }) => ({
  product:  one(products,  { fields: [adCreativeAssets.productId],  references: [products.id] }),
  user:     one(users,     { fields: [adCreativeAssets.userId],     references: [users.id] }),
  campaign: one(campaigns, { fields: [adCreativeAssets.campaignId], references: [campaigns.id] }),
}));

export const adMediaAssetsRelations = relations(adMediaAssets, ({ one }) => ({
  product:  one(products,  { fields: [adMediaAssets.productId],  references: [products.id] }),
  campaign: one(campaigns, { fields: [adMediaAssets.campaignId], references: [campaigns.id] }),
}));

export const aiJobResultsRelations = relations(aiJobResults, ({ one }) => ({
  user: one(users, { fields: [aiJobResults.userId], references: [users.id] }),
}));

export const aiMemoryRelations = relations(aiMemory, ({ one }) => ({
  sourceCampaignRef: one(campaigns, {
    fields:     [aiMemory.sourceCampaign],
    references: [campaigns.id],
  }),
}));

export const campaignMetricsRelations = relations(campaignMetrics, ({ one }) => ({
  campaign: one(campaigns, { fields: [campaignMetrics.campaignId], references: [campaigns.id] }),
}));
