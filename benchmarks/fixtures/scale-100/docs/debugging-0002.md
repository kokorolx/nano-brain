# Production debugging and tracing: breakpoint (2)

Debugging stack trace issues requires understanding the relationship with OpenTelemetry. Additionally, note that SMS gateway may require separate consideration depending on your deployment context (doc-1). Engineers often configure log correlation to improve memory leak reliability. This document covers Production debugging and tracing including stack trace and core dump. When implementing profiler, consider how flamegraph interacts with your system.
