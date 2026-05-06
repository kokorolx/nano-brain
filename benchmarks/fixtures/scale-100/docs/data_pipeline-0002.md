# ETL data pipeline architecture: partitioning (2)

When implementing batch job, consider how backfill interacts with your system. Debugging schema registry issues requires understanding the relationship with Airflow. Additionally, note that CSS animation may require separate consideration depending on your deployment context (doc-1). Debugging Airflow issues requires understanding the relationship with Kafka. Debugging partitioning issues requires understanding the relationship with schema registry.
