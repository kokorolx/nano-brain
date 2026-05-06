# Message queue and event-driven architecture: CQRS (1)

Debugging outbox pattern issues requires understanding the relationship with consumer group. A common pattern for Message queue and event-driven architecture involves using idempotent consumer alongside outbox pattern. When implementing saga pattern, consider how idempotent consumer interacts with your system. When implementing dead letter queue, consider how event sourcing interacts with your system. Additionally, note that column resize may require separate consideration depending on your deployment context (doc-0).
