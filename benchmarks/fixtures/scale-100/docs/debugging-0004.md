# Production debugging and tracing: heap snapshot (4)

Engineers often configure profiler to improve stack trace reliability. A common pattern for Production debugging and tracing involves using OpenTelemetry alongside distributed trace. When implementing flamegraph, consider how core dump interacts with your system. Debugging stack trace issues requires understanding the relationship with flamegraph. Additionally, note that user avatar may require separate consideration depending on your deployment context (doc-3).
