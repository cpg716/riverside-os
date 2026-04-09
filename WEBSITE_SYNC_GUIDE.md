# Riverside OS — Website Syncing (Webhooks)

Riverside OS includes a powerful **Outbound Webhook Engine** that allows it to instantly notify external systems (Shopify, WordPress, WooCommerce, or custom databases) whenever an order is finalized.

## 1. How it works
The Rust backend is configured with an optional `RIVERSIDE_WEBHOOK_URL` environment variable. 
When a checkout is successfully completed:
1.  The backend captures the full JSON representation of the new order.
2.  It spawns an **asynchronous `tokio` task** to POST the data to your configured URL.
3.  Because it is asynchronous, the checkout process remains lightning-fast even if the external website is slow to respond.

## 2. Configuration
To enable the sync engine, add the following to your server's `.env` or environment variables:

```bash
RIVERSIDE_WEBHOOK_URL="https://your-website.com/api/webhooks/riverside-os"
```

## 3. Webhook Payload Shape
The sync engine sends a standard JSON `POST` request. The payload matches the `DbOrder` and `DbOrderItem` structures.

### Example Payload
```json
{
  "order_id": "uuid-v4-here",
  "booked_at": "2026-04-02T12:00:00Z",
  "fulfilled_at": "2026-04-02T12:00:00Z",
  "total_gross": "100.00",
  "total_tax": "8.75",
  "operator_id": "staff-code-01",
  "items": [
    {
      "sku": "SKU-123",
      "product_name": "Wedding Suit",
      "qty": 1,
      "unit_price": "100.00",
      "fulfillment_type": "takeaway"
    }
  ]
}
```

## 4. Troubleshooting
- **Logging**: The backend uses the `tracing` library. To see webhook activity, run the server with `RUST_LOG=riverside_server=info`.
- **Distributed traces** (optional): when **`OTEL_*`** / **`RIVERSIDE_OTEL_ENABLED`** are configured, webhook-related work appears in your OTLP backend — **`docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`**.
- **Errors**: If a webhook fails (e.g., 404 or Timeout), it will be logged in the terminal as an "Error" but will **not** prevent the POS from finishing the sale.
- **Retries**: Currently, the engine is "fire-and-forget." For mission-critical syncs, we recommend using a service like **Make.com** or **Zapier** as the target URL to handle retries and queuing.
