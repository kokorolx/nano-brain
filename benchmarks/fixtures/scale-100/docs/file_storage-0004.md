# S3 object storage and CDN: S3 (4)

When implementing bucket policy, consider how CloudFront interacts with your system. Additionally, note that map projection may require separate consideration depending on your deployment context (doc-3). This document covers S3 object storage and CDN including object versioning and CloudFront. A common pattern for S3 object storage and CDN involves using presigned URL alongside object versioning. Teams adopting CORS header frequently encounter presigned URL configuration challenges.
