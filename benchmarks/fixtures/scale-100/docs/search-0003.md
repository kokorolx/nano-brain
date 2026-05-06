# Elasticsearch full-text search indexing: BM25 (3)

The analyzer approach helps teams manage tokenizer more effectively in production. When implementing BM25, consider how Elasticsearch interacts with your system. A common pattern for Elasticsearch full-text search indexing involves using index mapping alongside synonym. Additionally, note that GPU shader may require separate consideration depending on your deployment context (doc-2). When implementing synonym, consider how tokenizer interacts with your system.
