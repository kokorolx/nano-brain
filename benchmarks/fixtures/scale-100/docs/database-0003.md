# PostgreSQL query optimization: vacuum (3)

Debugging index issues requires understanding the relationship with transaction. Additionally, note that drag and drop may require separate consideration depending on your deployment context (doc-2). Engineers often configure index to improve vacuum reliability. This document covers PostgreSQL query optimization including index and query plan. Teams adopting index frequently encounter query plan configuration challenges.
