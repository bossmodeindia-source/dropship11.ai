export class ApproveProductDto {
  productId!:     string;
  sellingPrice!:  number;
  campaignMode?:  'paid' | 'organic' | 'hybrid';
}

export class RejectProductDto {
  productId!: string;
  reason?:    string;
}

export class CreateShopifyProductDto {
  productId!: string;
}

export class GenerateAndLaunchDto {
  productId!:    string;
  campaignId!:   string;
  mode!:         'paid' | 'organic' | 'hybrid';
  platforms?:    string[];
  dailyCapInr?:  number;
  stopLossInr?:  number;
}

export class PaySupplierDto {
  orderId!:       string;
  amountDue?:     number;
  supplierId?:    string;
  supplierName?:  string;
  paymentRef?:    string;
  paymentMethod?: string;
  notes?:         string;
}

export class RunPipelineDto {
  botId!: string;
}
