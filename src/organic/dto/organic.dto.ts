export class CreateOrganicPostDto {
  productId!:   string;
  platforms!:   Array<'instagram' | 'facebook' | 'instagram_reels' | 'facebook_reels'>;
  campaignId?:  string;
  caption?:     string;
  hook?:        string;
  hashtags?:    string[];
  mediaUrls?:   string[];
  scheduledAt?: Date;
}

export class ScheduleOrganicPostDto extends CreateOrganicPostDto {
  scheduledAt!: Date;
}

export class BoostOrganicPostDto {
  budgetInr!: number;
}
