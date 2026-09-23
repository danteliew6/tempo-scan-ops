"""Phase 1c — bronze_sales_raw: raw ingested sell-through events (all strings) with intentional dirt.

Drives the Lakeflow data-quality / expectations story: ~8% of rows violate a rule
(null product_id, null region, negative units, bad status enum, out-of-range price,
malformed order_ts) plus duplicate sale_ids. The DQ pipeline quarantines these.
"""
from pyspark.sql import functions as F
from common import get_spark, fq

spark = get_spark()
src = spark.table(fq("fact_sales"))

# raw string representation of the sell-through feed
raw = src.select(
    "sale_id", "product_id", "outlet_id", "dc_id", "account_id",
    "region", "province", "city", "division", "brand", "category",
    F.date_format("order_ts", "yyyy-MM-dd HH:mm:ss").alias("order_ts"),
    F.date_format("ship_ts", "yyyy-MM-dd HH:mm:ss").alias("ship_ts"),
    F.col("units_ordered").cast("string").alias("units_ordered"),
    F.col("units_fulfilled").cast("string").alias("units_fulfilled"),
    F.col("unit_price_idr").cast("string").alias("unit_price_idr"),
    F.col("gross_idr").cast("string").alias("gross_idr"),
    F.col("discount_idr").cast("string").alias("discount_idr"),
    F.col("net_idr").cast("string").alias("net_idr"),
    "channel",
    F.col("promo_flag").cast("string").alias("promo_flag"),
    "status",
).withColumn("_r", F.rand(101))

# inject dirt on disjoint bands (~8% total)
dirty = (raw
    # 0.000-0.016 : null product_id
    .withColumn("product_id", F.when(F.col("_r") < 0.016, F.lit(None)).otherwise(F.col("product_id")))
    # 0.016-0.030 : null region
    .withColumn("region", F.when((F.col("_r") >= 0.016) & (F.col("_r") < 0.030), F.lit(None)).otherwise(F.col("region")))
    # 0.030-0.044 : negative units_ordered
    .withColumn("units_ordered", F.when((F.col("_r") >= 0.030) & (F.col("_r") < 0.044), F.lit("-5")).otherwise(F.col("units_ordered")))
    # 0.044-0.058 : invalid status enum
    .withColumn("status", F.when((F.col("_r") >= 0.044) & (F.col("_r") < 0.058), F.lit("UNKNOWN")).otherwise(F.col("status")))
    # 0.058-0.070 : out-of-range unit_price (negative)
    .withColumn("unit_price_idr", F.when((F.col("_r") >= 0.058) & (F.col("_r") < 0.070), F.lit("-1200")).otherwise(F.col("unit_price_idr")))
    # 0.070-0.080 : malformed order_ts
    .withColumn("order_ts", F.when((F.col("_r") >= 0.070) & (F.col("_r") < 0.080), F.lit("N/A")).otherwise(F.col("order_ts")))
    .withColumn("_ingest_ts", F.current_timestamp())
    .drop("_r"))

# duplicate ~1% of sale_ids (append a resampled copy)
dupes = dirty.sample(fraction=0.01, seed=7)
bronze = dirty.unionByName(dupes)

bronze.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(fq("bronze_sales_raw"))
total = spark.table(fq("bronze_sales_raw")).count()
print(f"bronze_sales_raw: {total} rows")

# quick DQ profile
spark.sql(f"""
SELECT
  round(100*avg(CASE WHEN product_id IS NULL THEN 1 ELSE 0 END),2) pct_null_product,
  round(100*avg(CASE WHEN region IS NULL THEN 1 ELSE 0 END),2) pct_null_region,
  round(100*avg(CASE WHEN cast(units_ordered as double) < 0 THEN 1 ELSE 0 END),2) pct_neg_units,
  round(100*avg(CASE WHEN status NOT IN ('fulfilled','partial','backorder','cancelled') THEN 1 ELSE 0 END),2) pct_bad_status,
  round(100*avg(CASE WHEN cast(unit_price_idr as double) <= 0 THEN 1 ELSE 0 END),2) pct_bad_price,
  round(100*avg(CASE WHEN order_ts = 'N/A' THEN 1 ELSE 0 END),2) pct_bad_ts
FROM {fq('bronze_sales_raw')}
""").show()
print("BRONZE DONE")
