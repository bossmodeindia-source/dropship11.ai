export class LaunchCampaignModeDto {
  productId!:     string;
  campaignId?:    string;
  mode!:          'paid' | 'organic' | 'hybrid';
  platforms?:     string[];
  dailyCapInr?:   number;
  stopLossInr?:   number;
  paidBudgetInr?: number;
}

export class ScaleCampaignDto {
  factor!: number;  // e.g. 1.5 = scale up 50%
}
