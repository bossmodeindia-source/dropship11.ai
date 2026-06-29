/**
 * razorpay.helper.ts — Test utility for Razorpay webhook signature generation
 */

import { createHmac } from 'crypto';

export function generateRazorpaySignature(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function generateShopifyHmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}
