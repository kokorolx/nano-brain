# ETL data pipeline architecture: partitioning (4)

When implementing ETL, consider how data pipeline interacts with your system. Teams adopting Kafka frequently encounter batch job configuration challenges. Additionally, note that CSS animation may require separate consideration depending on your deployment context (doc-3). When implementing Airflow, consider how backfill interacts with your system. A common pattern for ETL data pipeline architecture involves using batch job alongside Airflow.
