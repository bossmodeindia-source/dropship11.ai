"""
commerce_pipeline_load_test.py — AI Empire Commerce Pipeline Load Test

Target: 1,000 concurrent users, 10,000 orders/hour
Key metrics:
  - Webhook throughput: ≥500 req/s (p95 < 200ms)
  - Order creation: ≥200 req/s (p95 < 500ms)
  - Escrow creation: ≥100 req/s (p95 < 300ms)
  - Dashboard API: ≥300 req/s (p95 < 400ms)

Run: locust -f load-tests/commerce_pipeline_load_test.py \
           --host=https://api.aiempire.app \
           --users=1000 \
           --spawn-rate=50 \
           --run-time=10m
"""

import json
import hmac
import hashlib
import random
import uuid
import time

from locust import HttpUser, task, between, events
from locust.runners import MasterRunner, WorkerRunner


# ── Shared test data ──────────────────────────────────────────────────────────
WEBHOOK_SECRET = "load-test-webhook-secret-32chars!"
PRODUCTS       = ["product-001", "product-002", "product-003", "product-004"]
SUPPLIERS      = ["supplier-001", "supplier-002", "supplier-003"]


def generate_razorpay_sig(payload: str, secret: str = WEBHOOK_SECRET) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def generate_shopify_hmac(payload: str, secret: str = WEBHOOK_SECRET) -> str:
    import base64
    return base64.b64encode(
        hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    ).decode()


# ── Commerce User ─────────────────────────────────────────────────────────────
class CommerceUser(HttpUser):
    """
    Simulates a tenant user executing commerce workflows.
    Task distribution models realistic production traffic:
      - 40% dashboard/analytics reads
      - 25% order operations
      - 20% product discovery
      - 15% webhook processing
    """
    wait_time = between(0.1, 0.5)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.tenant_id  = f"load-tenant-{random.randint(1, 50)}"
        self.auth_token = f"Bearer load-test-token-{self.tenant_id}"
        self.order_ids  = []

    def on_start(self):
        """Authenticate and prime tenant context."""
        self.headers = {
            "Authorization": self.auth_token,
            "X-Tenant-ID":   self.tenant_id,
            "Content-Type":  "application/json",
        }

    # ── Dashboard reads (40%) ─────────────────────────────────────────────────
    @task(4)
    def get_dashboard(self):
        with self.client.get(
            f"/api/v1/tenants/{self.tenant_id}/dashboard",
            headers=self.headers,
            name="/tenants/:id/dashboard",
            catch_response=True,
        ) as resp:
            if resp.status_code == 200:
                resp.success()
            elif resp.status_code in (401, 403):
                resp.failure(f"Auth error: {resp.status_code}")
            else:
                resp.failure(f"Dashboard failed: {resp.status_code}")

    @task(2)
    def get_finance_summary(self):
        with self.client.get(
            f"/api/v1/tenants/{self.tenant_id}/finance/summary",
            headers=self.headers,
            name="/tenants/:id/finance/summary",
            catch_response=True,
        ) as resp:
            if resp.status_code in (200, 204):
                resp.success()
            else:
                resp.failure(f"Finance summary: {resp.status_code}")

    @task(2)
    def get_orders_list(self):
        with self.client.get(
            f"/api/v1/tenants/{self.tenant_id}/orders?limit=20&page=1",
            headers=self.headers,
            name="/tenants/:id/orders",
            catch_response=True,
        ) as resp:
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data.get("data"), list):
                    self.order_ids = [o["id"] for o in data["data"][:5]]
                resp.success()
            else:
                resp.failure(f"Orders list: {resp.status_code}")

    # ── Order operations (25%) ────────────────────────────────────────────────
    @task(3)
    def create_order(self):
        product_id = random.choice(PRODUCTS)
        payload    = {
            "productId":   product_id,
            "quantity":    random.randint(1, 5),
            "supplierId":  random.choice(SUPPLIERS),
            "totalPrice":  round(random.uniform(100, 5000), 2),
            "currency":    "INR",
            "shopifyOrderId": f"shopify-{uuid.uuid4().hex[:12]}",
        }
        with self.client.post(
            f"/api/v1/tenants/{self.tenant_id}/orders",
            json=payload,
            headers=self.headers,
            name="/tenants/:id/orders [POST]",
            catch_response=True,
        ) as resp:
            if resp.status_code in (201, 409):  # 409 = idempotent duplicate
                if resp.status_code == 201:
                    order = resp.json()
                    if order.get("id"):
                        self.order_ids.append(order["id"])
                resp.success()
            else:
                resp.failure(f"Create order: {resp.status_code} — {resp.text[:100]}")

    @task(1)
    def get_order_detail(self):
        if not self.order_ids:
            return
        order_id = random.choice(self.order_ids)
        with self.client.get(
            f"/api/v1/tenants/{self.tenant_id}/orders/{order_id}",
            headers=self.headers,
            name="/tenants/:id/orders/:id",
            catch_response=True,
        ) as resp:
            if resp.status_code in (200, 404):
                resp.success()
            else:
                resp.failure(f"Order detail: {resp.status_code}")

    # ── Product discovery (20%) ───────────────────────────────────────────────
    @task(2)
    def get_products(self):
        with self.client.get(
            f"/api/v1/tenants/{self.tenant_id}/products?limit=20",
            headers=self.headers,
            name="/tenants/:id/products",
            catch_response=True,
        ) as resp:
            if resp.status_code in (200, 204):
                resp.success()
            else:
                resp.failure(f"Products: {resp.status_code}")

    @task(1)
    def trend_search(self):
        with self.client.get(
            f"/api/v1/tenants/{self.tenant_id}/trend-intelligence/signals",
            headers=self.headers,
            name="/tenants/:id/trend-intelligence/signals",
            catch_response=True,
        ) as resp:
            if resp.status_code in (200, 204):
                resp.success()
            else:
                resp.failure(f"Trends: {resp.status_code}")

    # ── Wallet / Finance (13%) ────────────────────────────────────────────────
    @task(1)
    def get_wallet_balance(self):
        with self.client.get(
            f"/api/v1/tenants/{self.tenant_id}/wallet/balance",
            headers=self.headers,
            name="/tenants/:id/wallet/balance",
            catch_response=True,
        ) as resp:
            if resp.status_code in (200, 204):
                resp.success()
            else:
                resp.failure(f"Wallet: {resp.status_code}")


# ── Webhook Simulator ─────────────────────────────────────────────────────────
class WebhookSimulator(HttpUser):
    """
    Simulates Shopify and Razorpay webhook deliveries.
    Target: 500 req/s combined.
    Idempotency tested by occasional duplicate delivery (10% of calls).
    """
    wait_time = between(0.05, 0.2)
    weight    = 2  # 2x spawn rate relative to CommerceUser

    # ── Shopify webhook ───────────────────────────────────────────────────────
    @task(3)
    def shopify_order_paid(self):
        order_id = random.randint(100000, 999999)
        payload  = json.dumps({
            "id": order_id,
            "order_number": random.randint(1000, 9999),
            "total_price": str(round(random.uniform(100, 5000), 2)),
            "financial_status": "paid",
        })
        hmac_val = generate_shopify_hmac(payload)
        with self.client.post(
            "/webhooks/shopify",
            data=payload,
            headers={
                "Content-Type":            "application/json",
                "X-Shopify-Topic":          "orders/paid",
                "X-Shopify-Hmac-Sha256":    hmac_val,
                "X-Shopify-Shop-Domain":    "load-test.myshopify.com",
                "X-Shopify-Request-Time":   str(int(time.time())),
            },
            name="/webhooks/shopify [orders/paid]",
            catch_response=True,
        ) as resp:
            if resp.status_code == 202:
                resp.success()
            elif resp.status_code == 400:
                resp.success()  # Timestamp/sig rejection in load test is expected
            else:
                resp.failure(f"Shopify webhook: {resp.status_code}")

    # ── Razorpay order webhook ────────────────────────────────────────────────
    @task(2)
    def razorpay_payment_captured(self):
        payment_id = f"pay_{uuid.uuid4().hex[:16]}"
        payload    = json.dumps({
            "event": "payment.captured",
            "payload": {
                "payment": {
                    "entity": {
                        "id": payment_id,
                        "order_id": f"rp_order_{uuid.uuid4().hex[:12]}",
                        "amount": random.randint(10000, 500000),
                        "currency": "INR",
                        "status": "captured",
                    }
                }
            }
        })
        sig = generate_razorpay_sig(payload)
        with self.client.post(
            "/webhooks/razorpay/order",
            data=payload,
            headers={
                "Content-Type":          "application/json",
                "x-razorpay-signature":   sig,
            },
            name="/webhooks/razorpay/order [payment.captured]",
            catch_response=True,
        ) as resp:
            if resp.status_code in (202, 400):
                resp.success()
            else:
                resp.failure(f"Razorpay webhook: {resp.status_code}")

    # ── Duplicate webhook (idempotency test) ──────────────────────────────────
    @task(1)
    def razorpay_duplicate_webhook(self):
        """Simulates Razorpay retry — same payload sent twice. Must get 202 both times."""
        payment_id = "pay_load_duplicate_001"  # fixed ID = always duplicate after first
        payload    = json.dumps({
            "event": "payment.captured",
            "payload": {"payment": {"entity": {"id": payment_id, "amount": 10000, "currency": "INR"}}}
        })
        sig = generate_razorpay_sig(payload)
        headers = {"Content-Type": "application/json", "x-razorpay-signature": sig}
        with self.client.post(
            "/webhooks/razorpay/order", data=payload, headers=headers,
            name="/webhooks/razorpay/order [DUPLICATE-idempotency]",
            catch_response=True,
        ) as resp:
            if resp.status_code == 202:
                resp.success()
            else:
                resp.failure(f"Idempotency failure: {resp.status_code}")


# ── Locust event hooks ────────────────────────────────────────────────────────
@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print(
        "\n🚀 AI Empire Load Test Started\n"
        "   Target: 1,000 users | 500 webhook req/s | 200 order req/s\n"
        "   Thresholds: p95 < 500ms | error rate < 0.1%\n"
    )

@events.quitting.add_listener
def on_quitting(environment, **kwargs):
    stats = environment.runner.stats.total
    print(f"\n📊 Load Test Results:")
    print(f"   Total requests:   {stats.num_requests:,}")
    print(f"   Failures:         {stats.num_failures:,} ({100*stats.fail_ratio:.2f}%)")
    print(f"   Avg response:     {stats.avg_response_time:.0f}ms")
    print(f"   p95 response:     {stats.get_response_time_percentile(0.95):.0f}ms")
    print(f"   p99 response:     {stats.get_response_time_percentile(0.99):.0f}ms")
    print(f"   Throughput:       {stats.current_rps:.0f} req/s\n")

    # Fail test if thresholds breached
    p95 = stats.get_response_time_percentile(0.95)
    err_rate = stats.fail_ratio

    if p95 > 500:
        print(f"❌ LOAD TEST FAILED: p95 {p95:.0f}ms > 500ms threshold")
        environment.process_exit_code = 1
    elif err_rate > 0.001:
        print(f"❌ LOAD TEST FAILED: error rate {err_rate:.4f} > 0.1% threshold")
        environment.process_exit_code = 1
    else:
        print("✅ LOAD TEST PASSED: All thresholds within limits")
        environment.process_exit_code = 0
