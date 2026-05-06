# Configuration management and feature flags: override (1)

When implementing feature flag, consider how environment variable interacts with your system. Additionally, note that handwriting recognition may require separate consideration depending on your deployment context (doc-0). A common pattern for Configuration management and feature flags involves using feature flag alongside LaunchDarkly. Teams adopting kill switch frequently encounter remote config configuration challenges. When implementing override, consider how kill switch interacts with your system.
