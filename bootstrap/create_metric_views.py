"""Bootstrap task — create the Unity Catalog metric views for Tempo Scan.

Two governed metric views are created directly over the curated fact tables
(§2 of CONTRACT.md), so they re-point at any workspace via tempo_config and need
no dashboard-owned SQL files:

  * `sales_metrics`          — over fact_sales: revenue (net/gross IDR), units,
                               fill rate, revenue-at-risk, order mix; dimensioned
                               by region / division / brand / category / channel /
                               status / date.
  * `inventory_risk_metrics` — over fact_inventory: expiry risk, stockout rate,
                               on-hand + at-risk units, days-of-supply / to-expiry;
                               dimensioned by region / division / brand / dc / date.

The YAML `WITH METRICS` body must NOT be split on ';', so each view is created
with a single spark.sql() call. Runs as a serverless spark_python_task in the
DABs bootstrap job.
"""
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tempo_config import S, fq, get_spark  # noqa: E402


def _sales_metrics_sql() -> str:
    return f"""
CREATE OR REPLACE VIEW {fq('sales_metrics')}
WITH METRICS
LANGUAGE YAML
AS $$
  version: 1.1
  source: {fq('fact_sales')}
  comment: "Governed sell-through KPIs for Tempo Scan — revenue, units, fill rate and revenue-at-risk across the distribution network."
  dimensions:
    - name: Sale Date
      expr: "to_date(order_ts)"
    - name: Sale Month
      expr: "date_trunc('MONTH', order_ts)"
    - name: Region
      expr: "region"
    - name: Province
      expr: "province"
    - name: City
      expr: "city"
    - name: Division
      expr: "division"
    - name: Brand
      expr: "brand"
    - name: Category
      expr: "category"
    - name: Channel
      expr: "channel"
    - name: Order Status
      expr: "status"
    - name: Is Promo
      expr: "(promo_flag = 1)"
  measures:
    - name: Order Count
      expr: "COUNT(1)"
    - name: Net Revenue IDR
      expr: "SUM(net_idr)"
    - name: Gross Revenue IDR
      expr: "SUM(gross_idr)"
    - name: Discount IDR
      expr: "SUM(discount_idr)"
    - name: Units Ordered
      expr: "SUM(units_ordered)"
    - name: Units Fulfilled
      expr: "SUM(units_fulfilled)"
    - name: Fill Rate
      expr: "SUM(units_fulfilled) / NULLIF(SUM(units_ordered), 0)"
    - name: Backorder Orders
      expr: "SUM(CASE WHEN status = 'backorder' THEN 1 ELSE 0 END)"
    - name: Partial Orders
      expr: "SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END)"
    - name: Stockout Rate
      expr: "SUM(CASE WHEN status IN ('backorder', 'partial') THEN 1 ELSE 0 END) / NULLIF(COUNT(1), 0)"
    - name: Revenue At Risk IDR
      expr: "SUM(CASE WHEN status IN ('backorder', 'partial', 'cancelled') THEN net_idr ELSE 0 END)"
    - name: Unique Outlets
      expr: "COUNT(DISTINCT outlet_id)"
    - name: Unique SKUs
      expr: "COUNT(DISTINCT product_id)"
$$
"""


def _inventory_risk_metrics_sql() -> str:
    return f"""
CREATE OR REPLACE VIEW {fq('inventory_risk_metrics')}
WITH METRICS
LANGUAGE YAML
AS $$
  version: 1.1
  source: {fq('fact_inventory')}
  comment: "Governed inventory + risk KPIs for Tempo Scan — expiry risk, stockout rate and on-hand exposure per DC and SKU."
  dimensions:
    - name: Reading Date
      expr: "to_date(reading_date)"
    - name: Region
      expr: "region"
    - name: Division
      expr: "division"
    - name: Brand
      expr: "brand"
    - name: Distribution Center
      expr: "dc_id"
  measures:
    - name: Readings
      expr: "COUNT(1)"
    - name: On Hand Units
      expr: "SUM(on_hand_units)"
    - name: In Transit Units
      expr: "SUM(in_transit_units)"
    - name: At Risk Expiry Units
      expr: "SUM(at_risk_expiry_units)"
    - name: Avg Expiry Risk Score
      expr: "AVG(expiry_risk_score)"
    - name: Stockout Rate
      expr: "SUM(stockout_flag) / NULLIF(COUNT(1), 0)"
    - name: Avg Days Of Supply
      expr: "AVG(days_of_supply)"
    - name: Avg Days To Expiry
      expr: "AVG(days_to_expiry)"
    - name: Avg Daily Demand
      expr: "AVG(avg_daily_demand)"
    - name: SKUs At Expiry Risk
      expr: "COUNT(DISTINCT CASE WHEN expiry_risk_score > 0.7 THEN product_id END)"
    - name: SKU DCs
      expr: "COUNT(DISTINCT concat(dc_id, '|', product_id))"
$$
"""


def main():
    spark = get_spark()
    for label, sql in (
        ("sales_metrics", _sales_metrics_sql()),
        ("inventory_risk_metrics", _inventory_risk_metrics_sql()),
    ):
        print(f"[metric-view] applying {label} against {S} ...")
        spark.sql(sql)
        print(f"[metric-view] OK: {label}")


if __name__ == "__main__":
    main()
