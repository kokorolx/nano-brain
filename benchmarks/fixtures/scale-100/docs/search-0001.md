# Elasticsearch full-text search indexing: search as you type (1)

Debugging relevance scoring issues requires understanding the relationship with search as you type. Engineers often configure Elasticsearch to improve relevance scoring reliability. Debugging relevance scoring issues requires understanding the relationship with BM25. When implementing relevance scoring, consider how tokenizer interacts with your system. Additionally, note that GPU shader may require separate consideration depending on your deployment context (doc-0).
