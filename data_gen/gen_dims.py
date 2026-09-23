"""Phase 1a — dimension tables + access allowlist for the Tempo Scan supply-chain demo.

Creates dim_product, dim_distribution_center, dim_outlet, dim_account (PII) and the
ungoverned access_allowlist that powers the column-mask / ABAC bypass demo.
"""
import random
from pyspark.sql import functions as F
from pyspark.sql.types import StringType
import pandas as pd
from common import (get_spark, fq, CATALOG, SCHEMA, DC_MASTER, DC_IDS,
                    BRANDS, BRAND_LIST, BRAND_WEIGHTS, N_PRODUCTS, N_OUTLETS,
                    REGIONS, OUTLET_TYPES, OUTLET_TYPE_WEIGHTS, CHAINS_BY_TYPE)

spark = get_spark()
spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA} "
          f"COMMENT 'Tempo Scan supply-chain demo — PT Tempo Scan pharma + consumer-health, "
          f"molecule to shelf, governed in Indonesia (AWS Jakarta). Governance + Genie + AI/BI + ML.'")

# ---------- pandas UDFs (self-contained Indonesian name pools; numpy only) ----------
_FIRST = ["Budi", "Siti", "Agus", "Dewi", "Andi", "Rina", "Joko", "Sri", "Bambang", "Ayu",
          "Putu", "Made", "Wayan", "Eka", "Rizki", "Dwi", "Fitri", "Yusuf", "Nurul", "Hendra",
          "Indah", "Rizal", "Lestari", "Adi", "Maya", "Fajar", "Ratna", "Teguh", "Wulan", "Iwan",
          "Dian", "Surya", "Nia", "Bayu", "Citra", "Gunawan", "Sari", "Hadi", "Tuti", "Reza"]
_LAST = ["Santoso", "Wijaya", "Susanto", "Hidayat", "Nugroho", "Saputra", "Kusuma", "Halim",
         "Pratama", "Wibowo", "Setiawan", "Gunawan", "Purnama", "Firdaus", "Maulana", "Utomo",
         "Permana", "Suryadi", "Anggraini", "Puspita", "Handoko", "Rahayu", "Siregar", "Simanjuntak",
         "Tanuwijaya", "Kurniawan", "Hartono", "Lesmana", "Yulianto", "Prabowo"]


@F.pandas_udf(StringType())
def fake_name(ids: pd.Series) -> pd.Series:
    import numpy as np
    rng = np.random.default_rng((int(ids.iloc[0]) if len(ids) else 0) + 7)
    fi = rng.integers(0, len(_FIRST), size=len(ids))
    li = rng.integers(0, len(_LAST), size=len(ids))
    return pd.Series([f"{_FIRST[a]} {_LAST[b]}" for a, b in zip(fi, li)])


@F.pandas_udf(StringType())
def fake_phone(ids: pd.Series) -> pd.Series:
    import numpy as np
    rng = np.random.default_rng(int(ids.iloc[0]) if len(ids) else 0)
    pref = ["811", "812", "813", "821", "822", "852", "853", "857", "878", "895"]
    out = []
    for _ in range(len(ids)):
        p = pref[rng.integers(0, len(pref))]
        out.append("+62" + p + "".join(str(d) for d in rng.integers(0, 10, size=7)))
    return pd.Series(out)


@F.pandas_udf(StringType())
def fake_nik(ids: pd.Series) -> pd.Series:
    import numpy as np
    rng = np.random.default_rng((int(ids.iloc[0]) if len(ids) else 0) + 999)
    return pd.Series(["".join(str(d) for d in rng.integers(0, 10, size=16)) for _ in range(len(ids))])


@F.pandas_udf(StringType())
def fake_email(names: pd.Series) -> pd.Series:
    import re
    out = []
    for i, n in enumerate(names):
        base = re.sub(r"[^a-z]", ".", str(n).lower()).strip(".")
        out.append(f"{base}{i%97}@apotek.co.id")
    return pd.Series(out)


# ---------- dim_product (SKU catalog, ~180 SKUs) ----------
_PACKS_BY_CAT = {
    "analgesic": ["4 tablets", "10 tablets", "20 tablets", "sachet"],
    "cold-flu": ["4 tablets", "10 tablets", "sachet"],
    "pediatric-analgesic": ["4 tablets", "sirup 60ml"],
    "cough-cold": ["4 tablets", "sirup 60ml", "sirup 100ml"],
    "topical-analgesic": ["cream 30g", "cream 60g", "koyo 10s"],
    "anti-inflammatory": ["10 tablets", "30 tablets", "kapsul 20s"],
    "multivitamin": ["kapsul 10s", "kapsul 30s"],
    "energy": ["botol 150ml", "kaleng 250ml"],
    "antiseptic": ["botol 100ml", "botol 250ml"],
    "household": ["botol 250ml", "botol 500ml"],
    "oral-care": ["botol 250ml", "botol 500ml"],
    "hand-body-lotion": ["botol 100ml", "botol 200ml", "pouch 400ml"],
    "baby-care": ["botol 100ml", "botol 200ml", "pouch 400ml"],
    "body-mist": ["botol 100ml", "botol 200ml"],
    "fragrance": ["botol 100ml"],
    "cosmetics": ["1's", "compact 12g", "tube 20g"],
    "color-cosmetics": ["1's", "tube 20g"],
}
_VARIANTS = ["Original", "Extra", "Forte", "Menthol", "Herbal", "Active", "Daily", "Fresh",
             "Gold", "Care", "Plus", "Kids", "Sensitive", "Cool", "Classic", "Premium"]

import numpy as np  # noqa: E402
_rng = np.random.default_rng(2026)
prod_rows = []
for i in range(N_PRODUCTS):
    brand = BRAND_LIST[_rng.choice(len(BRAND_LIST), p=BRAND_WEIGHTS)]
    division, cats, tclass = BRANDS[brand]
    category = cats[_rng.integers(0, len(cats))]
    pack = _PACKS_BY_CAT.get(category, ["1's"])[_rng.integers(0, len(_PACKS_BY_CAT.get(category, ["1's"])))]
    variant = _VARIANTS[_rng.integers(0, len(_VARIANTS))]
    product_name = f"{brand} {variant} {pack}"
    is_pharma = division in ("Pharma-Rx", "Pharma-OTC")
    therapeutic_class = tclass if is_pharma else "n/a"
    # ~12% short shelf-life SKUs (expiry-risk candidates); cold-chain skus skew short.
    cold_chain = bool(_rng.random() < (0.35 if is_pharma else 0.06))
    short = _rng.random() < 0.12 or (cold_chain and _rng.random() < 0.5)
    shelf_life_days = int(_rng.integers(120, 271)) if short else int(_rng.integers(365, 1096))
    # BPOM registration number (plausible format by division)
    if division == "Pharma-Rx":
        bpom = f"DKL{_rng.integers(1000000000, 9999999999)}A1"
    elif division == "Pharma-OTC":
        bpom = f"DTL{_rng.integers(1000000000, 9999999999)}B1"
    elif division == "Consumer-Health":
        bpom = f"POM SD{_rng.integers(100000000, 999999999)}"
    else:
        bpom = f"NA{_rng.integers(10000000000, 99999999999)}"
    unit_cost = int(_rng.integers(1500, 45000))
    unit_price = int(unit_cost * float(_rng.uniform(1.35, 2.4)) // 100 * 100)
    status = "active" if _rng.random() < 0.94 else "discontinued"
    prod_rows.append((f"SKU-{i:05d}", product_name, brand, division, category,
                      therapeutic_class, pack, shelf_life_days, cold_chain, bpom,
                      unit_cost, unit_price, status))

prod_cols = ["product_id", "product_name", "brand", "division", "category",
             "therapeutic_class", "pack_size", "shelf_life_days", "requires_cold_chain",
             "bpom_reg_no", "unit_cost_idr", "unit_price_idr", "status"]
prod_df = (spark.createDataFrame(prod_rows, prod_cols)
           .withColumn("unit_cost_idr", F.col("unit_cost_idr").cast("long"))
           .withColumn("unit_price_idr", F.col("unit_price_idr").cast("long"))
           .withColumn("shelf_life_days", F.col("shelf_life_days").cast("int")))
prod_df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(fq("dim_product"))
print(f"dim_product: {prod_df.count()} rows")

# ---------- dim_distribution_center (~18 DCs) ----------
dc_rows = []
for i, (name, city, province, region, lat, lng, cold) in enumerate(DC_MASTER):
    random.seed(i)
    cap = int(random.uniform(0.8, 3.5) * 1_000_000)
    dc_rows.append((DC_IDS[i], name, city, province, region, lat, lng, cap, cold))
dc_df = (spark.createDataFrame(
            dc_rows,
            ["dc_id", "dc_name", "city", "province", "region", "lat", "lng",
             "capacity_units", "cold_chain_capable"])
         .withColumn("capacity_units", F.col("capacity_units").cast("long")))
dc_df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(fq("dim_distribution_center"))
print(f"dim_distribution_center: {dc_df.count()} rows")

# ---------- dim_outlet (~2,500 retail endpoints, each served by a DC) ----------
# Distribute outlets across DCs weighted by region (Jawa dominant via #DCs there).
_DC_TUPLES = [(DC_IDS[i], m[1], m[2], m[3]) for i, m in enumerate(DC_MASTER)]  # (dc_id, city, province, region)


def make_outlets(pdf_iter):
    import numpy as np
    import pandas as pd
    dc_tuples = _DC_TUPLES
    otypes = OUTLET_TYPES
    otype_w = np.array(OUTLET_TYPE_WEIGHTS)
    chains = CHAINS_BY_TYPE
    for pdf in pdf_iter:
        rng = np.random.default_rng(4000 + int(pdf["id"].iloc[0]))
        rows = []
        for _, r in pdf.iterrows():
            oid = int(r["id"])
            dc_id, city, province, region = dc_tuples[rng.integers(0, len(dc_tuples))]
            otype = otypes[rng.choice(len(otypes), p=otype_w)]
            chain = chains[otype][rng.integers(0, len(chains[otype]))]
            tier = ["A", "B", "C"][rng.choice(3, p=[0.22, 0.45, 0.33])]
            outlet_name = f"{chain} {city} {oid % 900 + 1:03d}"
            status = "active" if rng.random() < 0.93 else "inactive"
            rows.append((f"OUT-{oid:06d}", outlet_name, otype, chain, city, province,
                         region, dc_id, tier, status))
        yield pd.DataFrame(rows, columns=["outlet_id", "outlet_name", "outlet_type", "chain",
                                          "city", "province", "region", "dc_id", "tier", "status"])


outlet_schema = ("outlet_id string, outlet_name string, outlet_type string, chain string, "
                 "city string, province string, region string, dc_id string, tier string, status string")
outlets = (spark.range(0, N_OUTLETS, numPartitions=8)
           .mapInPandas(make_outlets, schema=outlet_schema))
outlets.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(fq("dim_outlet"))
print(f"dim_outlet: {spark.table(fq('dim_outlet')).count()} rows")

# ---------- dim_account (PII — one registered pharmacist/owner per outlet) ----------
_ACCT_TYPES = F.when(F.rand(11) < 0.55, "retail") \
               .when(F.rand(11) < 0.80, "chain") \
               .when(F.rand(11) < 0.93, "hospital").otherwise("wholesale")
ol = spark.table(fq("dim_outlet")).select("outlet_id", "region").withColumn(
    "acc_idx", F.monotonically_increasing_id())
accounts = (ol
    .withColumn("account_id", F.concat(F.lit("ACC-"), F.lpad((F.col("acc_idx") % 1000000).cast("string"), 6, "0")))
    .withColumn("contact_name", fake_name(F.col("acc_idx")))
    .withColumn("nik", fake_nik(F.col("acc_idx")))
    .withColumn("phone", fake_phone(F.col("acc_idx")))
    .withColumn("contact_name_dup", F.col("contact_name"))
    .withColumn("email", fake_email(F.col("contact_name_dup")))
    .drop("contact_name_dup")
    .withColumn("credit_limit_idr", (F.floor(F.rand(12) * 190 + 10) * 1_000_000).cast("long"))
    .withColumn("member_since", F.expr("date_sub(current_date(), cast(rand(13)*2555 as int))"))
    .withColumn("account_type", _ACCT_TYPES)
    .select("account_id", "outlet_id", "contact_name", "nik", "email", "phone", "region",
            "credit_limit_idr", "member_since", "account_type"))
accounts.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(fq("dim_account"))
print(f"dim_account: {spark.table(fq('dim_account')).count()} rows")

# ---------- access_allowlist (UNGOVERNED — powers mask/ABAC bypass) ----------
allow_rows = [
    ("dante.liew@databricks.com", "ALL", True),
    ("national.analyst@temposcan.co.id", "ALL", False),
    ("jawa.rm@temposcan.co.id", "Jawa", False),
    ("sumatera.rm@temposcan.co.id", "Sumatera", False),
]
allow_df = spark.createDataFrame(allow_rows, ["email", "allowed_region", "is_admin"])
allow_df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(fq("access_allowlist"))
print(f"access_allowlist: {allow_df.count()} rows")

print("DIMS DONE")
