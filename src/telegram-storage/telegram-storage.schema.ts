/**
 * telegram-storage.schema.ts — Shared types for Telegram Storage infrastructure
 */

export type AssetType =
  | 'video' | 'image' | 'reel' | 'zip' | 'backup'
  | 'creative' | 'pdf' | 'report' | 'strategy'
  | 'export' | 'website-build' | 'other';

export type ChannelType =
  | 'video' | 'image' | 'reel' | 'zip' | 'backup'
  | 'creative' | 'pdf' | 'report' | 'strategy' | 'export' | 'general';

export type StorageStatus = 'pending' | 'uploading' | 'stored' | 'failed' | 'archived' | 'deleted';
export type BotStatus     = 'active' | 'overloaded' | 'flood_wait' | 'disabled' | 'banned';

// ── Channel assignment map ─────────────────────────────────────────────────────
export const ASSET_TO_CHANNEL: Record<AssetType, ChannelType> = {
  video:          'video',
  reel:           'reel',
  image:          'image',
  creative:       'creative',
  zip:            'zip',
  backup:         'backup',
  pdf:            'pdf',
  report:         'report',
  strategy:       'strategy',
  export:         'export',
  'website-build':'export',
  other:          'general',
};

// ── DB row types ───────────────────────────────────────────────────────────────
export interface TelegramBotRow {
  id:                  string;
  bot_name:            string;
  bot_username:        string;
  bot_token_encrypted: string;
  status:              BotStatus;
  current_load:        number;
  max_capacity:        number;
  flood_wait_until:    Date | null;
  total_uploads:       number;
  total_bytes:         number;
  last_health_check:   Date | null;
  is_active:           boolean;
  assigned_channels:   { channelId: string; channelType: ChannelType }[];
  metadata:            Record<string, unknown>;
  created_at:          Date;
  updated_at:          Date;
}

export interface TelegramChannelRow {
  id:                   string;
  channel_name:         string;
  channel_id_encrypted: string;
  channel_type:         ChannelType;
  status:               'active' | 'full' | 'disabled';
  asset_count:          number;
  max_assets:           number;
  total_bytes:          number;
  assigned_bot_ids:     string[];
  is_active:            boolean;
  created_at:           Date;
  updated_at:           Date;
}

export interface TelegramAssetRow {
  id:                    string;
  tenant_id:             string;
  user_id:               string;
  project_id:            string | null;
  campaign_id:           string | null;
  asset_type:            AssetType;
  file_name:             string;
  mime_type:             string;
  file_size:             number;
  checksum:              string;
  telegram_file_id:      string | null;
  telegram_message_id:   string | null;
  telegram_channel_id:   string | null;
  storage_bot_id:        string | null;
  channel_record_id:     string | null;
  storage_status:        StorageStatus;
  is_archived:           boolean;
  archive_key:           string | null;
  archive_bucket:        string | null;
  archived_at:           Date | null;
  tags:                  Record<string, string>;
  metadata:              Record<string, unknown>;
  created_at:            Date;
  updated_at:            Date;
  expires_at:            Date | null;
}

// ── Service return types ───────────────────────────────────────────────────────
export interface UploadedAsset {
  id:             string;
  fileId:         string;
  messageId:      string;
  channelId:      string;
  storageStatus:  StorageStatus;
  deduped:        boolean;
}

export interface AssetMeta {
  id:           string;
  tenantId:     string;
  userId:       string;
  assetType:    AssetType;
  fileName:     string;
  mimeType:     string;
  fileSize:     number;
  storageStatus: StorageStatus;
  isArchived:   boolean;
  createdAt:    Date;
  projectId?:   string;
  campaignId?:  string;
  tags?:        Record<string, string>;
}

export interface BotHealth {
  botId:        string;
  botUsername:  string;
  status:       BotStatus;
  currentLoad:  number;
  maxCapacity:  number;
  loadPct:      number;
  isFloodWait:  boolean;
  floodUntil?:  Date;
  lastCheck:    Date | null;
}

export interface PoolMetrics {
  totalBots:      number;
  activeBots:     number;
  overloadedBots: number;
  floodWaitBots:  number;
  disabledBots:   number;
  totalAssets:    number;
  totalBytes:     number;
  dedupSavings:   number;
}

// ── Queue job payloads ─────────────────────────────────────────────────────────
export interface UploadJobPayload {
  assetId:    string;
  tenantId:   string;
  userId:     string;
  fileBuffer: string;   // base64 encoded
  fileName:   string;
  mimeType:   string;
  assetType:  AssetType;
  checksum:   string;
  projectId?: string;
  campaignId?: string;
}

export interface ReplicationJobPayload {
  assetId:    string;
  tenantId:   string;
  fileId:     string;
  botId:      string;
  fileName:   string;
  mimeType:   string;
}

export interface HealthMonitorJobPayload {
  botId?: string;   // undefined = check all bots
}
