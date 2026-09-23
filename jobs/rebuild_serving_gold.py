"""Rebuild the Lakebase serving-gold tables from curated sell-through (Lakeflow Job task).

Recomputes gold_region_daily, gold_national_daily and gold_sales_serving so the app's
served state reflects the freshly-ingested micro-batch. Runs as a serverless
spark_python_task after the DQ pipeline task. (gold_product_risk and gold_demand_forecast
are produced by the ML tasks and refreshed on their own cadence.)
"""
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
from tempo_config import S, get_spark  # noqa: E402

spark = get_spark()

spark.sql(f"""
CREATE OR REPLACE TABLE {S}.gold_region_daily AS
SELECT region, sales_date,
       COUNT(*) AS orders,
       COUNT(*) AS order_count,
       SUM(units_ordered) AS units_ordered,
       SUM(units_ordered) AS demand_units,
       SUM(units_fulfilled) AS units_fulfilled,
       SUM(CASE WHEN status = 'backorder' THEN 1 ELSE 0 END) AS backorder_count,
       ROUND(SUM(units_fulfilled)/NULLIF(SUM(units_ordered),0),4) AS fill_rate,
       ROUND(AVG(CASE WHEN is_stockout THEN 1.0 ELSE 0 END),4) AS stockout_rate,
       SUM(net_idr) AS net_idr,
       SUM(revenue_at_risk_idr) AS revenue_at_risk_idr
FROM {S}.sales_curated_gold
GROUP BY 1,2
""")

spark.sql(f"""
CREATE OR REPLACE TABLE {S}.gold_national_daily AS
SELECT sales_date,
       COUNT(*) AS orders,
       COUNT(*) AS order_count,
       SUM(units_ordered) AS units_ordered,
       SUM(units_ordered) AS demand_units,
       SUM(units_fulfilled) AS units_fulfilled,
       SUM(CASE WHEN status = 'backorder' THEN 1 ELSE 0 END) AS backorder_count,
       ROUND(SUM(units_fulfilled)/NULLIF(SUM(units_ordered),0),4) AS fill_rate,
       ROUND(AVG(CASE WHEN is_stockout THEN 1.0 ELSE 0 END),4) AS stockout_rate,
       SUM(net_idr) AS net_idr,
       SUM(revenue_at_risk_idr) AS revenue_at_risk_idr
FROM {S}.sales_curated_gold
GROUP BY 1
""")

# Recent sell-through rows (last 45 days) — powers the app's tables from Postgres. NO PII.
spark.sql(f"""
CREATE OR REPLACE TABLE {S}.gold_sales_serving AS
SELECT s.sale_id, s.order_ts, s.sales_date, s.region, s.province, s.city, s.dc_id,
       s.division, s.brand, s.category, s.product_id, p.product_name, s.outlet_id,
       s.units_ordered, s.units_fulfilled, s.unit_price_idr,
       s.gross_idr, s.discount_idr, s.net_idr, s.revenue_at_risk_idr, s.channel, s.promo_flag, s.status
FROM {S}.sales_curated_gold s
LEFT JOIN {S}.dim_product p ON s.product_id = p.product_id
WHERE s.order_ts >= date_sub(current_date(),45)
""")

rd = spark.table(f"{S}.gold_region_daily").count()
nd = spark.table(f"{S}.gold_national_daily").count()
ss = spark.table(f"{S}.gold_sales_serving").count()
print(f"REBUILT gold_region_daily={rd} rows, gold_national_daily={nd} rows, gold_sales_serving={ss} rows.")
