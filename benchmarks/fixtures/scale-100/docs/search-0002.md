# Elasticsearch full-text search indexing: BM25 (2)

When implementing relevance scoring, consider how fuzzy match interacts with your system. When implementing search as you type, consider how synonym interacts with your system. Engineers often configure synonym to improve analyzer reliability. This document covers Elasticsearch full-text search indexing including index mapping and fuzzy match. Additionally, note that binary tree may require separate consideration depending on your deployment context (doc-1).
