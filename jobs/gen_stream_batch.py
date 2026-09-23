"""Real-time ingestion — append a fresh micro-batch of synthetic sell-through to bronze.

Run as a serverless spark_python_task inside the Lakeflow Job. Samples existing
fact_sales rows (guarantees referential integrity with the dims), re-stamps them with
the CURRENT time, re-injects the same ~8% data-quality dirt, and APPENDS to
bronze_sales_raw. The DQ pipeline reads bronze as a STREAM, so each batch flows
bronze -> silver/quarantine -> curated gold on the next pipeline run.

IMPORTANT: only ever APPEND here — overwriting bronze would break the streaming
source and force a full pipeline refresh.
"""
import os
import sys
from pyspark.sql import functions as F

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
from tempo_config import fq as FQ, get_spark  # noqa: E402

# batch size (arg 1, default 400) — small so each scheduled run (every 10 min) is cheap
N = int(sys.argv[1]) if len(sys.argv) > 1 else 400

spark = get_spark()

# Sample real sales -> valid FKs; restamp to "now"; recompute a fresh sale_id.
# sample() avoids the full global sort that orderBy(rand()) would force on fact_sales.
_total = spark.table(FQ("fact_sales")).count()
_frac = min(1.0, (N * 3.0) / max(_total, 1))
base = (
    spark.table(FQ("fact_sales"))
    .sample(withReplacement=False, fraction=_frac, seed=None)
    .limit(N)
    .withColumn("_offset_s", (F.rand() * 300).cast("int"))          # order within last 5 min
    .withColumn("order_ts_t", F.current_timestamp() - F.make_interval(F.lit(0), F.lit(0), F.lit(0), F.lit(0), F.lit(0), F.lit(0), F.col("_offset_s")))
    .withColumn("_ship_lag_h", (F.rand() * 48 + 2).cast("int"))     # 2-50 h to ship
    .withColumn("ship_ts_t", F.when(F.col("status").isin("backorder", "cancelled"), F.lit(None))
                .otherwise(F.col("order_ts_t") + F.make_interval(F.lit(0), F.lit(0), F.lit(0), F.lit(0), F.col("_ship_lag_h"), F.lit(0), F.lit(0))))
    # fresh unique sale_id so dedup keeps them
    .withColumn("sale_id", F.concat(F.lit("RT-"), F.date_format(F.current_timestamp(), "yyyyMMddHHmmss"), F.lit("-"), F.monotonically_increasing_id().cast("string")))
)

# Cast to the bronze string schema (raw ingest representation).
raw = base.select(
    "sale_id", "product_id", "outlet_id", "dc_id", "account_id",
    "region", "province", "city", "division", "brand", "category",
    F.date_format("order_ts_t", "yyyy-MM-dd HH:mm:ss").alias("order_ts"),
    F.date_format("ship_ts_t", "yyyy-MM-dd HH:mm:ss").alias("ship_ts"),
    F.col("units_ordered").cast("string").alias("units_ordered"),
    F.col("units_fulfilled").cast("string").alias("units_fulfilled"),
    F.col("unit_price_idr").cast("string").alias("unit_price_idr"),
    F.col("gross_idr").cast("string").alias("gross_idr"),
    F.col("discount_idr").cast("string").alias("discount_idr"),
    F.col("net_idr").cast("string").alias("net_idr"),
    "channel",
    F.col("promo_flag").cast("string").alias("promo_flag"),
    "status",
).withColumn("_r", F.rand())

# Re-inject the same six disjoint-band defects (~8%) as gen_bronze.py so every DQ
# rule keeps receiving fresh violations live (null product, null region, negative units,
# bad status enum, out-of-range price, malformed timestamp).
dirty = (raw
    .withColumn("product_id", F.when(F.col("_r") < 0.016, F.lit(None)).otherwise(F.col("product_id")))
    .withColumn("region", F.when((F.col("_r") >= 0.016) & (F.col("_r") < 0.030), F.lit(None)).otherwise(F.col("region")))
    .withColumn("units_ordered", F.when((F.col("_r") >= 0.030) & (F.col("_r") < 0.044), F.lit("-5")).otherwise(F.col("units_ordered")))
    .withColumn("status", F.when((F.col("_r") >= 0.044) & (F.col("_r") < 0.058), F.lit("UNKNOWN")).otherwise(F.col("status")))
    .withColumn("unit_price_idr", F.when((F.col("_r") >= 0.058) & (F.col("_r") < 0.070), F.lit("-1200")).otherwise(F.col("unit_price_idr")))
    .withColumn("order_ts", F.when((F.col("_r") >= 0.070) & (F.col("_r") < 0.080), F.lit("N/A")).otherwise(F.col("order_ts")))
    .withColumn("_ingest_ts", F.current_timestamp())
    .drop("_r"))

# Append the batch. Row COUNT is deterministic (sample+limit yields N rows); only the
# column values are random, so counting before the write is safe. (cache()/persist is
# not supported on serverless compute, so we don't materialize the frame.)
appended = dirty.count()
dirty.write.mode("append").saveAsTable(FQ("bronze_sales_raw"))
total = spark.table(FQ("bronze_sales_raw")).count()
print(f"APPENDED ~{appended} fresh sell-through rows to bronze (current-time). bronze total now {total}.")
