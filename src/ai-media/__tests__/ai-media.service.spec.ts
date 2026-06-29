import { AiMediaService } from '../ai-media.service';
import { AiMediaClient } from '../ai-media.client';
import { AdMediaAssetsRepository } from '../ad-media-assets.repository';

const client = {
  generateImage: jest.fn(),
  generateVideo: jest.fn(),
};

const repository = {
  findByHash: jest.fn(),
  save: jest.fn(),
  incrementUseCount: jest.fn(),
  getBestCreative: jest.fn(),
};

const orchestrator = {
  resolve: jest.fn(),
};

const product = {
  id: 'product-1',
  title: 'Wireless Earbuds',
  category: 'electronics',
  description: 'Noise cancelling earbuds',
  tags: ['audio', 'wireless'],
  decision: 'RUN_ADS',
};

describe('AiMediaService', () => {
  let service: AiMediaService;

  beforeEach(() => {
    jest.clearAllMocks();
    repository.findByHash.mockResolvedValue(null);
    repository.save.mockResolvedValue({ id: 'asset-1' });
    repository.incrementUseCount.mockResolvedValue(undefined);
    repository.getBestCreative.mockResolvedValue(null);
    orchestrator.resolve.mockResolvedValue({
      source: 'BOT',
      content: {
        imagePrompt: 'premium square product photo',
        videoPrompt: 'short vertical product reveal',
        imageModel: 'image-model',
        videoModel: 'video-model',
      },
    });
    client.generateImage.mockResolvedValue('https://cdn.example.com/image.jpg');
    client.generateVideo.mockResolvedValue('https://cdn.example.com/video.mp4');

    service = new AiMediaService(
      client as unknown as AiMediaClient,
      repository as unknown as AdMediaAssetsRepository,
      orchestrator as never,
    );
  });

  it('returns cached ad media without calling generation APIs', async () => {
    repository.findByHash.mockResolvedValue({
      id: 'asset-cached',
      imageUrl: 'https://cdn.example.com/cached.jpg',
      videoUrl: 'https://cdn.example.com/cached.mp4',
      success: true,
      useCount: 4,
    });

    const result = await service.generateAdMedia(product);

    expect(result).toEqual(
      expect.objectContaining({
        imageUrl: 'https://cdn.example.com/cached.jpg',
        videoUrl: 'https://cdn.example.com/cached.mp4',
        cached: true,
        assetId: 'asset-cached',
        success: true,
      }),
    );
    expect(repository.incrementUseCount).toHaveBeenCalledWith('asset-cached');
    expect(client.generateImage).not.toHaveBeenCalled();
    expect(client.generateVideo).not.toHaveBeenCalled();
  });

  it('uses orchestrator prompts and persists generated ad media on cache miss', async () => {
    const result = await service.generateAdMedia(product, 'campaign-1');

    expect(orchestrator.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'media',
        context: expect.objectContaining({ title: product.title }),
      }),
    );
    expect(client.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'premium square product photo', model: 'image-model' }),
    );
    expect(client.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'short vertical product reveal', model: 'video-model' }),
    );
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'product-1',
        campaignId: 'campaign-1',
        imageUrl: 'https://cdn.example.com/image.jpg',
        videoUrl: 'https://cdn.example.com/video.mp4',
        success: true,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        cached: false,
        assetId: 'asset-1',
        provider: 'open-generative-ai',
        success: true,
      }),
    );
  });

  it('returns direct image and video URLs from legacy helpers', async () => {
    await expect(service.generateImage('product prompt')).resolves.toBe('https://cdn.example.com/image.jpg');
    await expect(service.generateVideo('video prompt')).resolves.toBe('https://cdn.example.com/video.mp4');
  });

  it('returns current helper DTOs for media transforms', async () => {
    await expect(service.generateI2I({ prompt: 'polish', imageUrl: 'https://x.test/ref.jpg' })).resolves.toEqual({
      url: 'https://cdn.example.com/image.jpg',
      provider: 'nvidia',
      success: true,
    });
    await expect(service.generateI2V({ prompt: 'animate', imageUrl: 'https://x.test/ref.jpg' })).resolves.toEqual({
      url: 'https://cdn.example.com/video.mp4',
      provider: 'nvidia',
      success: true,
    });
    await expect(service.generateV2V({ prompt: 'clean', videoUrl: 'https://x.test/raw.mp4' })).resolves.toEqual({
      url: 'https://cdn.example.com/video.mp4',
      provider: 'nvidia',
      success: true,
    });
  });

  it('returns local upload and lipsync DTOs without external calls', async () => {
    await expect(
      service.processLipSync({ videoUrl: 'https://cdn.example.com/source.mp4', audioUrl: 'https://cdn.example.com/audio.mp3' }),
    ).resolves.toEqual({
      url: 'https://cdn.example.com/source.mp4',
      provider: 'lipsync',
      success: true,
    });

    await expect(service.uploadFile({ originalname: 'product.jpg' } as Express.Multer.File)).resolves.toEqual({
      url: '/uploads/product.jpg',
      provider: 'local',
      success: true,
    });
  });
});
