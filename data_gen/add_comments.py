"""Phase 1d — table + column comments for Genie / catalog discoverability."""
from common import get_spark, fq

spark = get_spark()

TABLE_COMMENTS = {
    "dim_product": "SKU catalog (~180 SKUs) for PT Tempo Scan pharma + consumer-health brands. "
                   "division in Pharma-Rx/Pharma-OTC/Consumer-Health/Personal-Care; therapeutic_class is "
                   "'n/a' for non-pharma. Short shelf_life_days SKUs drive the expiry-risk story.",
    "dim_distribution_center": "PT Tempo distribution centers (~18) across Indonesian regions. lat/lng power "
                               "the Command Center map. cold_chain_capable flags DCs that can hold cold-chain SKUs.",
    "dim_outlet": "Retail endpoints (~2,500) served by a DC. outlet_type in "
                  "pharmacy/modern_trade/minimarket/hospital/wholesaler; tier A/B/C.",
    "dim_account": "Registered pharmacist/owner per outlet. Contains regulated health-sector PII "
                   "(contact_name, nik, email, phone) governed for UU PDP.",
    "fact_sales": "Sell-through orders (gold), one row per order line. net_idr in Indonesian Rupiah; "
                  "status in fulfilled/partial/backorder/cancelled. A flu-season surge in Jawa + Sumatera "
                  "over the recent 30 days shows elevated backorder/partial for OTC analgesics/cough-cold.",
    "fact_inventory": "Daily DC x SKU inventory (gold). expiry_risk_score in [0,1] (>=0.7 actionable); "
                      "stockout_flag=1 when the SKU is out at the DC. Short-shelf over-stocked SKUs trend "
                      "toward expiry write-off; flu-surge SKUs in Jawa/Sumatera stock out in the recent window.",
    "bronze_sales_raw": "RAW ingested sell-through events (all strings) with intentional data-quality defects "
                        "(~8%): null product_id, null region, negative units, bad status enum, out-of-range "
                        "price, malformed timestamp, plus duplicate sale_ids. Source for the Lakeflow DQ pipeline.",
    "access_allowlist": "UNGOVERNED access map (email -> allowed_region, is_admin) powering the "
                        "column-mask and row-filter demo bypass.",
}

COL_COMMENTS = {
    "dim_product": {
        "product_id": "Unique SKU identifier (SKU-#####)",
        "shelf_life_days": "Manufacturer shelf life in days; short values drive the expiry-risk story",
        "requires_cold_chain": "True when the SKU needs cold-chain handling",
        "bpom_reg_no": "BPOM (Indonesian FDA) registration number",
        "therapeutic_class": "Therapeutic class for pharma SKUs; 'n/a' for consumer/personal-care",
    },
    "fact_sales": {
        "sale_id": "Unique order-line identifier",
        "net_idr": "Net revenue in Indonesian Rupiah (fulfilled units minus discount)",
        "status": "fulfilled, partial, backorder, or cancelled",
        "units_ordered": "Units requested on the order line",
        "units_fulfilled": "Units actually shipped (< ordered on partial; 0 on backorder/cancelled)",
        "order_ts": "Timestamp the order was placed",
        "region": "Indonesian island-group region (ABAC row-filter column)",
    },
    "fact_inventory": {
        "expiry_risk_score": "Model-derived expiry-write-off risk in [0,1]; >=0.7 is actionable (ML target)",
        "stockout_flag": "1 if the SKU is out of stock at the DC on that day",
        "days_of_supply": "on_hand_units divided by average daily demand",
        "days_to_expiry": "Days until the on-hand batch expires",
        "at_risk_expiry_units": "Units projected to expire unsold before the batch expiry date",
        "avg_daily_demand": "Smoothed average daily demand for the SKU at the DC",
    },
    "dim_account": {
        "contact_name": "Registered contact full name (PII)",
        "nik": "Indonesian national ID number, 16 digits (PII)",
        "email": "Account email (PII)",
        "phone": "Account phone (PII)",
    },
}

for t, c in TABLE_COMMENTS.items():
    spark.sql(f"COMMENT ON TABLE {fq(t)} IS '{c.replace(chr(39), chr(39)+chr(39))}'")
for t, cols in COL_COMMENTS.items():
    for col, c in cols.items():
        spark.sql(f"ALTER TABLE {fq(t)} ALTER COLUMN {col} COMMENT '{c.replace(chr(39), chr(39)+chr(39))}'")
print("COMMENTS DONE")
