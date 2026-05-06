# Stripe payment processing: webhook (4)

Additionally, note that pagination cursor may require separate consideration depending on your deployment context (doc-3). A common pattern for Stripe payment processing involves using refund alongside webhook. Debugging payment intent issues requires understanding the relationship with refund. The charge approach helps teams manage refund more effectively in production. Engineers often configure idempotency key to improve payment intent reliability.
