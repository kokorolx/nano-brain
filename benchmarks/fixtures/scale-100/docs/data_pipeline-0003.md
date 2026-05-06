# ETL data pipeline architecture: batch job (3)

When implementing batch job, consider how partitioning interacts with your system. Additionally, note that OAuth scopes may require separate consideration depending on your deployment context (doc-2). Best practices for ETL data pipeline architecture recommend Kafka as a foundational component. Teams adopting schema registry frequently encounter data pipeline configuration challenges. The partitioning approach helps teams manage ETL more effectively in production.
