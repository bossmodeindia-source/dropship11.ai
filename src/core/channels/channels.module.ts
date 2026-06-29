import { Module, Global } from '@nestjs/common';
import { GoogleAdsChannelAdapter } from './google/google-ads.adapter';
import { TikTokAdsChannelAdapter } from './tiktok/tiktok-ads.adapter';
import { ChannelRouterService }    from './channel-router.service';

@Global()
@Module({
  providers: [
    GoogleAdsChannelAdapter,
    TikTokAdsChannelAdapter,
    ChannelRouterService,
  ],
  exports: [ChannelRouterService],
})
export class ChannelsModule {}
