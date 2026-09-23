"""Phase 1b — fact_sales (big sell-through fact) + fact_inventory (DC x SKU x day).

Business stories baked in:
 - STOCKOUT SPIKE (headline): in the most-recent ~30 days a flu-season demand surge for
   OTC analgesics / cough-cold (Bodrex, Oskadon, Bodrexin, Hemaviton) hits Jawa + Sumatera.
   fact_sales.status shifts to backorder/partial and fact_inventory.stockout_flag spikes:
   ~1 in 4 high-demand SKU-days stock out -> lost revenue.
 - EXPIRY RISK: ~12% of SKUs (short shelf-life, over-stocked in specific DCs) trend
   expiry_risk_score past 0.7 over the window -> the ML target for the risk model.
 - FORECASTABLE DEMAND: demand has weekly (weekday/weekend), monthly and seasonal (flu)
   structure by region/division -> the demand-forecast model.
"""
from pyspark.sql import functions as F
from common import (get_spark, fq, N_SALES, N_INV_SKUS, HISTORY_DAYS,
                    REGIONS, REGION_WEIGHTS, FLU_SURGE_BRANDS, FLU_SURGE_REGIONS)

spark = get_spark()

# ---- small dims collected to the driver (all tiny) ----
prows = spark.table(fq("dim_product")).select(
    "product_id", "brand", "division", "category", "unit_price_idr").collect()
PRODUCTS = [(r["product_id"], r["brand"], r["division"], r["category"], int(r["unit_price_idr"]),
             r["brand"] in FLU_SURGE_BRANDS) for r in prows]
FLU_IDX = [i for i, p in enumerate(PRODUCTS) if p[5]]
ALL_IDX = list(range(len(PRODUCTS)))

# outlet + its account, keyed for region-weighted sampling
orows = (spark.table(fq("dim_outlet")).alias("o")
         .join(spark.table(fq("dim_account")).select("outlet_id", "account_id").alias("a"),
               "outlet_id", "left")
         .select("outlet_id", "dc_id", "region", "province", "city", "outlet_type", "account_id")
         .collect())
OUTLETS = [(r["outlet_id"], r["dc_id"], r["region"], r["province"], r["city"],
            r["outlet_type"], r["account_id"]) for r in orows]
REGION_TO_OUTLETS = {reg: [] for reg in REGIONS}
for i, o in enumerate(OUTLETS):
    REGION_TO_OUTLETS.setdefault(o[2], []).append(i)
# regions that actually have outlets (guard empty)
REGION_POOL = [r for r in REGIONS if REGION_TO_OUTLETS.get(r)]
REGION_POOL_W = None
if REGION_POOL:
    import numpy as _np
    _w = _np.array([REGION_WEIGHTS[REGIONS.index(r)] for r in REGION_POOL], dtype=float)
    REGION_POOL_W = (_w / _w.sum()).tolist()

SURGE_REGIONS = set(FLU_SURGE_REGIONS)


# ---------- fact_sales via mapInPandas ----------
def gen_sales(pdf_iter):
    import numpy as np
    import pandas as pd
    products = PRODUCTS
    outlets = OUTLETS
    region_pool = REGION_POOL
    region_pool_w = np.array(REGION_POOL_W) if REGION_POOL_W else None
    region_to_outlets = REGION_TO_OUTLETS
    flu_idx = np.array(FLU_IDX) if FLU_IDX else None
    all_idx = np.array(ALL_IDX)
    today = pd.Timestamp.now().normalize()
    for pdf in pdf_iter:
        n = len(pdf)
        seed = int(pdf["id"].iloc[0])
        rng = np.random.default_rng(seed + 31)
        rows = []
        # region then outlet
        reg_choice = rng.choice(len(region_pool), size=n, p=region_pool_w) if region_pool_w is not None \
            else rng.integers(0, len(region_pool), size=n)
        day_off = rng.integers(0, HISTORY_DAYS, size=n)
        u_status = rng.random(n)
        u_prod = rng.random(n)
        u_flu = rng.random(n)
        for i in range(n):
            region = region_pool[reg_choice[i]]
            o_idx = region_to_outlets[region][rng.integers(0, len(region_to_outlets[region]))]
            outlet_id, dc_id, o_region, province, city, otype, account_id = outlets[o_idx]
            recent = day_off[i] < 30
            surge_region = region in SURGE_REGIONS
            # product selection — flu-surge SKUs over-selected in recent surge-region window
            flu_p = 0.55 if (recent and surge_region) else 0.14
            if flu_idx is not None and u_flu[i] < flu_p:
                p_idx = int(flu_idx[rng.integers(0, len(flu_idx))])
            else:
                p_idx = int(all_idx[rng.integers(0, len(all_idx))])
            product_id, brand, division, category, unit_price, is_flu = products[p_idx]
            surge_row = recent and surge_region and is_flu
            # demand
            base_units = float(np.exp(rng.normal(2.4, 0.7)))  # ~11 median
            if surge_row:
                base_units *= rng.uniform(1.6, 2.8)
            units_ordered = int(max(1, round(base_units)))
            # status — surge rows stock out ~1 in 4
            if surge_row:
                # fulfilled .62 / partial .16 / backorder .16 / cancelled .06
                s = u_status[i]
                status = ("fulfilled" if s < 0.62 else "partial" if s < 0.78
                          else "backorder" if s < 0.94 else "cancelled")
            else:
                s = u_status[i]
                status = ("fulfilled" if s < 0.90 else "partial" if s < 0.94
                          else "backorder" if s < 0.96 else "cancelled")
            if status == "fulfilled":
                units_fulfilled = units_ordered
            elif status == "partial":
                units_fulfilled = int(max(1, round(units_ordered * rng.uniform(0.3, 0.8))))
            else:  # backorder / cancelled
                units_fulfilled = 0
            gross = units_ordered * unit_price
            promo = int(rng.random() < 0.16)
            discount = int(round(gross * rng.uniform(0.05, 0.22))) if promo else 0
            net = max(0, units_fulfilled * unit_price - discount)
            # channel
            if otype in ("modern_trade", "minimarket"):
                channel = "modern_trade" if rng.random() < 0.75 else "distributor"
            elif otype == "wholesaler":
                channel = "distributor"
            else:
                channel = "distributor" if rng.random() < 0.6 else "direct"
            # timestamps
            mins = int(rng.integers(0, 1440))
            order_ts = today - pd.to_timedelta(int(day_off[i]), unit="D") + pd.to_timedelta(mins, unit="m")
            if status in ("backorder", "cancelled"):
                ship_ts = pd.NaT
            else:
                ship_ts = order_ts + pd.to_timedelta(float(rng.uniform(2, 72)), unit="h")
            rows.append((f"SAL-{seed + i:08d}", product_id, outlet_id, dc_id, account_id,
                         region, province, city, division, brand, category,
                         order_ts, ship_ts, units_ordered, units_fulfilled, unit_price,
                         gross, discount, net, channel, promo, status))
        df = pd.DataFrame(rows, columns=[
            "sale_id", "product_id", "outlet_id", "dc_id", "account_id",
            "region", "province", "city", "division", "brand", "category",
            "order_ts", "ship_ts", "units_ordered", "units_fulfilled", "unit_price_idr",
            "gross_idr", "discount_idr", "net_idr", "channel", "promo_flag", "status"])
        df["order_ts"] = pd.to_datetime(df["order_ts"])
        df["ship_ts"] = pd.to_datetime(df["ship_ts"])
        yield df


sales_schema = (
    "sale_id string, product_id string, outlet_id string, dc_id string, account_id string, "
    "region string, province string, city string, division string, brand string, category string, "
    "order_ts timestamp, ship_ts timestamp, units_ordered long, units_fulfilled long, "
    "unit_price_idr long, gross_idr long, discount_idr long, net_idr long, "
    "channel string, promo_flag int, status string")

sales = spark.range(0, N_SALES, numPartitions=16).mapInPandas(gen_sales, schema=sales_schema)
sales.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(fq("fact_sales"))
n_sales = spark.table(fq("fact_sales")).count()
print(f"fact_sales: {n_sales} rows")

# ---------- fact_inventory (DC x top-SKU x day) via mapInPandas ----------
# Choose the tracked SKUs: all flu-surge SKUs + all short-shelf (expiry) SKUs, then top up by
# sales volume to N_INV_SKUS so both stories are represented.
prod = spark.table(fq("dim_product")).select(
    "product_id", "brand", "division", "shelf_life_days", "requires_cold_chain")
vol = (spark.table(fq("fact_sales")).groupBy("product_id")
       .agg(F.sum("units_ordered").alias("vol")))
prod = prod.join(vol, "product_id", "left").fillna({"vol": 0})
prod = (prod
        .withColumn("is_flu_surge", F.col("brand").isin(FLU_SURGE_BRANDS))
        .withColumn("is_expiry", F.col("shelf_life_days") <= F.lit(270)))
# priority: flu-surge + expiry candidates first, then by volume
must = prod.filter("is_flu_surge OR is_expiry")
rest = (prod.filter("NOT (is_flu_surge OR is_expiry)")
        .orderBy(F.col("vol").desc()))
n_must = must.count()
top_rest = rest.limit(max(0, N_INV_SKUS - n_must))
tracked = must.unionByName(top_rest).limit(N_INV_SKUS)

# cross tracked SKUs with all DCs -> base (dc, product) grid
dc = spark.table(fq("dim_distribution_center")).select(
    "dc_id", "region", "cold_chain_capable")
base = (tracked.select("product_id", "brand", "division", "shelf_life_days",
                       "is_flu_surge", "is_expiry")
        .crossJoin(dc)
        .repartition(16))


def gen_inventory(pdf_iter):
    import numpy as np
    import pandas as pd
    surge_regions = SURGE_REGIONS
    today = pd.Timestamp.now().normalize()
    div_base = {"Pharma-OTC": 18.0, "Pharma-Rx": 8.0, "Consumer-Health": 12.0, "Personal-Care": 14.0}
    reg_mult = {"Jawa": 1.30, "Sumatera": 1.10, "Kalimantan": 0.9, "Sulawesi": 0.85, "Bali-Nusra": 0.8}
    for pdf in pdf_iter:
        out = []
        for _, r in pdf.iterrows():
            dc_id = r["dc_id"]
            region = r["region"]
            product_id = r["product_id"]
            brand = r["brand"]
            division = r["division"]
            shelf = int(r["shelf_life_days"])
            is_flu = bool(r["is_flu_surge"])
            is_expiry = bool(r["is_expiry"])
            rng = np.random.default_rng(abs(hash((dc_id, product_id))) % (2**32))
            surge_here = is_flu and (region in surge_regions)
            # expiry-hot in ~half the DCs for short-shelf SKUs
            expiry_hot = is_expiry and (abs(hash((product_id, dc_id))) % 2 == 0)
            ad0 = max(2.0, rng.normal(div_base.get(division, 12.0), div_base.get(division, 12.0) * 0.3))
            ad0 *= reg_mult.get(region, 1.0)
            lead_time = int(rng.integers(5, 11))
            target_dos = rng.uniform(45, 90) if is_expiry else rng.uniform(12, 25)
            batch_age0 = shelf * (0.70 if expiry_hot else 0.20)
            for d in range(HISTORY_DAYS):
                day = today - pd.Timedelta(days=(HISTORY_DAYS - 1 - d))
                dow = day.dayofweek
                dow_factor = 0.9 if dow >= 5 else 1.05
                month_factor = 1.0 + 0.08 * np.sin(2 * np.pi * (day.dayofyear / 365.0))
                seasonal = 1.0
                if surge_here and d >= 60:
                    seasonal = 1.0 + 1.4 * ((d - 60) / 29.0)
                avg_daily_demand = round(float(ad0 * dow_factor * month_factor * seasonal), 1)
                # on-hand
                forced_stockout = surge_here and d >= 60 and rng.random() < 0.25
                if forced_stockout:
                    on_hand = int(max(0, round(avg_daily_demand * rng.uniform(0.0, 0.5))))
                else:
                    on_hand = int(max(0, round(avg_daily_demand * target_dos * rng.uniform(0.8, 1.15))))
                reorder_point = int(round(avg_daily_demand * lead_time))
                in_transit = int(round(reorder_point * rng.uniform(0.0, 1.5))) if on_hand < reorder_point else int(round(reorder_point * rng.uniform(0.0, 0.6)))
                reserved = int(round(avg_daily_demand * rng.uniform(0.5, 2.0)))
                days_of_supply = round(on_hand / max(avg_daily_demand, 1.0), 2)
                stockout_flag = int(forced_stockout or on_hand <= reserved * 0.5)
                # expiry
                dte = int(np.clip(shelf - batch_age0 - d * 0.3, 3, shelf))
                batch_expiry = (today + pd.Timedelta(days=dte)).date()
                at_risk = int(max(0, on_hand - round(avg_daily_demand * dte)))
                overstock = at_risk / max(on_hand, 1)
                urgency = float(np.clip(1 - dte / 90.0, 0, 1))
                if expiry_hot:
                    es = 0.30 + 0.45 * (d / (HISTORY_DAYS - 1)) + 0.15 * overstock + rng.normal(0, 0.04)
                else:
                    es = 0.5 * overstock * urgency + rng.normal(0, 0.03)
                expiry_risk_score = round(float(np.clip(es, 0.0, 1.0)), 3)
                out.append((dc_id, product_id, day, region, division, brand,
                            on_hand, in_transit, reserved, days_of_supply, reorder_point,
                            batch_expiry, dte, at_risk, avg_daily_demand,
                            stockout_flag, expiry_risk_score))
        yield pd.DataFrame(out, columns=[
            "dc_id", "product_id", "reading_date", "region", "division", "brand",
            "on_hand_units", "in_transit_units", "reserved_units", "days_of_supply", "reorder_point",
            "batch_expiry_date", "days_to_expiry", "at_risk_expiry_units", "avg_daily_demand",
            "stockout_flag", "expiry_risk_score"])


inv_schema = (
    "dc_id string, product_id string, reading_date timestamp, region string, division string, "
    "brand string, on_hand_units long, in_transit_units long, reserved_units long, "
    "days_of_supply double, reorder_point long, batch_expiry_date date, days_to_expiry int, "
    "at_risk_expiry_units long, avg_daily_demand double, stockout_flag int, expiry_risk_score double")

inv = base.mapInPandas(gen_inventory, schema=inv_schema)
inv.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(fq("fact_inventory"))
print(f"fact_inventory: {spark.table(fq('fact_inventory')).count()} rows")
print("FACTS DONE")
