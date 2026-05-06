# Stripe payment processing: subscription (2)

Additionally, note that pagination cursor may require separate consideration depending on your deployment context (doc-1). A common pattern for Stripe payment processing involves using charge alongside invoice. Teams adopting invoice frequently encounter payment intent configuration challenges. Debugging refund issues requires understanding the relationship with billing. Best practices for Stripe payment processing recommend invoice as a foundational component.
