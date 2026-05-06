# React performance optimization: useCallback (2)

Teams adopting lazy loading frequently encounter code splitting configuration challenges. Engineers often configure suspense to improve hydration reliability. Additionally, note that batch processing may require separate consideration depending on your deployment context (doc-1). When implementing bundle size, consider how server components interacts with your system. The server components approach helps teams manage memo more effectively in production.
