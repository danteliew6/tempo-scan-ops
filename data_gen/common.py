"""Shared config + domain master for the Tempo Scan supply-chain demo data generation.

Catalog / schema / profile / Spark bootstrap come from the repo-root ``tempo_config``
module (env-driven), so the whole data-gen stage re-points at another workspace via
environment variables set by the DABs bootstrap job. Defaults reproduce the original build.

Domain: PT Tempo Scan Group — pharma (Rx/OTC) + consumer/personal-care manufacturing,
distributed through PT Tempo's national distribution network to retail sell-through.
All data is synthetic.
"""
import os
import sys

# Make the repo-root config importable whether this runs as `python3 data_gen/x.py`
# locally (sys.path[0] == data_gen/) or as a job task.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tempo_config import CATALOG, SCHEMA, PROFILE, get_spark, fq  # noqa: E402,F401

# ---- row counts ----
N_PRODUCTS = 180          # dim_product SKU catalog
N_OUTLETS = 2_500         # dim_outlet retail endpoints
N_ACCOUNTS = N_OUTLETS    # dim_account — one registered pharmacist/owner per outlet
N_SALES = 120_000         # fact_sales sell-through rows
N_INV_SKUS = 40           # top SKUs tracked in fact_inventory (DC x SKU x day)
HISTORY_DAYS = 90

# ---- geography: Indonesian island-group regions (Jawa dominant) ----
REGIONS = ["Jawa", "Sumatera", "Kalimantan", "Sulawesi", "Bali-Nusra"]
REGION_WEIGHTS = [0.52, 0.22, 0.10, 0.09, 0.07]

# ---- divisions ----
DIVISIONS = ["Pharma-Rx", "Pharma-OTC", "Consumer-Health", "Personal-Care"]

# ---- brand pool (real Tempo Scan brands; synthetic data) ----
# brand -> (division, [product categories], therapeutic_class or 'n/a')
BRANDS = {
    "Bodrex":        ("Pharma-OTC",      ["analgesic", "cold-flu"],        "Analgesic/Antipyretic"),
    "Bodrexin":      ("Pharma-OTC",      ["pediatric-analgesic"],          "Analgesic/Antipyretic"),
    "Oskadon":       ("Pharma-OTC",      ["analgesic"],                    "Analgesic/Antipyretic"),
    "Contrexyn":     ("Pharma-OTC",      ["cough-cold"],                   "Cough & Cold"),
    "NEO Rheumason": ("Pharma-OTC",      ["topical-analgesic"],            "Topical Musculoskeletal"),
    "Nonflamin":     ("Pharma-Rx",       ["anti-inflammatory"],            "NSAID"),
    "Hemaviton":     ("Consumer-Health", ["multivitamin", "energy"],       "n/a"),
    "S.O.S":         ("Consumer-Health", ["antiseptic", "household"],      "n/a"),
    "Total Care":    ("Consumer-Health", ["oral-care"],                    "n/a"),
    "Marina":        ("Personal-Care",   ["hand-body-lotion"],             "n/a"),
    "My Baby":       ("Personal-Care",   ["baby-care"],                    "n/a"),
    "Vitalis":       ("Personal-Care",   ["body-mist", "fragrance"],       "n/a"),
    "Claudia":       ("Personal-Care",   ["cosmetics"],                    "n/a"),
    "Revlon":        ("Personal-Care",   ["cosmetics", "color-cosmetics"], "n/a"),
}
BRAND_LIST = list(BRANDS.keys())
# allocation weight of each brand across the 180-SKU catalog (OTC + personal-care heavy)
BRAND_WEIGHTS = [0.12, 0.06, 0.09, 0.07, 0.05, 0.05, 0.08, 0.05, 0.05,
                 0.08, 0.07, 0.06, 0.05, 0.07]
# Normalize so the vector sums to exactly 1.0 (numpy's choice(p=...) requires it,
# and hand-tuned weights drift). Guards against ValueError: probabilities do not sum to 1.
_bw_total = sum(BRAND_WEIGHTS)
BRAND_WEIGHTS = [w / _bw_total for w in BRAND_WEIGHTS]

# STOCKOUT-SPIKE story: flu-season OTC analgesics / cough-cold surge in these regions.
FLU_SURGE_BRANDS = ["Bodrex", "Oskadon", "Bodrexin", "Hemaviton"]
FLU_SURGE_REGIONS = ["Jawa", "Sumatera"]

# ---- PT Tempo distribution centers (the map layer / "zone" analog) ----
# (dc_name, city, province, region, lat, lng, cold_chain_capable)
DC_MASTER = [
    # Jawa (dominant)
    ("Tempo DC Jakarta",      "Jakarta",     "DKI Jakarta",           "Jawa",       -6.2000, 106.8167, True),
    ("Tempo DC Cikarang",     "Cikarang",    "Jawa Barat",            "Jawa",       -6.3050, 107.1520, True),
    ("Tempo DC Bandung",      "Bandung",     "Jawa Barat",            "Jawa",       -6.9175, 107.6191, False),
    ("Tempo DC Semarang",     "Semarang",    "Jawa Tengah",           "Jawa",       -6.9667, 110.4167, True),
    ("Tempo DC Surabaya",     "Surabaya",    "Jawa Timur",            "Jawa",       -7.2575, 112.7521, True),
    ("Tempo DC Tangerang",    "Tangerang",   "Banten",                "Jawa",       -6.1783, 106.6319, False),
    ("Tempo DC Yogyakarta",   "Yogyakarta",  "DI Yogyakarta",         "Jawa",       -7.7956, 110.3695, False),
    ("Tempo DC Malang",       "Malang",      "Jawa Timur",            "Jawa",       -7.9797, 112.6304, False),
    # Sumatera
    ("Tempo DC Medan",        "Medan",       "Sumatera Utara",        "Sumatera",    3.5952,  98.6722, True),
    ("Tempo DC Palembang",    "Palembang",   "Sumatera Selatan",      "Sumatera",   -2.9761, 104.7754, False),
    ("Tempo DC Pekanbaru",    "Pekanbaru",   "Riau",                  "Sumatera",    0.5071, 101.4478, False),
    ("Tempo DC Padang",       "Padang",      "Sumatera Barat",        "Sumatera",   -0.9471, 100.4172, False),
    # Kalimantan
    ("Tempo DC Balikpapan",   "Balikpapan",  "Kalimantan Timur",      "Kalimantan", -1.2379, 116.8529, False),
    ("Tempo DC Banjarmasin",  "Banjarmasin", "Kalimantan Selatan",    "Kalimantan", -3.3186, 114.5944, False),
    # Sulawesi
    ("Tempo DC Makassar",     "Makassar",    "Sulawesi Selatan",      "Sulawesi",   -5.1477, 119.4327, True),
    ("Tempo DC Manado",       "Manado",      "Sulawesi Utara",        "Sulawesi",    1.4748, 124.8421, False),
    # Bali-Nusra
    ("Tempo DC Denpasar",     "Denpasar",    "Bali",                  "Bali-Nusra", -8.6705, 115.2126, True),
    ("Tempo DC Mataram",      "Mataram",     "Nusa Tenggara Barat",   "Bali-Nusra", -8.5833, 116.1167, False),
]
N_DCS = len(DC_MASTER)

# Derived DC id list (index i -> DC-000, DC-001, ...) — kept in sync with dim_distribution_center.
DC_IDS = [f"DC-{i:03d}" for i in range(N_DCS)]

# retail outlet channel/chain master
OUTLET_TYPES = ["pharmacy", "modern_trade", "minimarket", "hospital", "wholesaler"]
OUTLET_TYPE_WEIGHTS = [0.34, 0.16, 0.30, 0.10, 0.10]
CHAINS_BY_TYPE = {
    "pharmacy":     ["Kimia Farma", "Apotek K-24", "Century", "Guardian Pharmacy", "Independent"],
    "modern_trade": ["Watsons", "Guardian", "Transmart", "Hypermart"],
    "minimarket":   ["Indomaret", "Alfamart", "Alfamidi", "Circle K"],
    "hospital":     ["RS Siloam", "RS Mitra Keluarga", "RS Hermina", "RSUD"],
    "wholesaler":   ["PBF Enseval", "PBF Anugerah", "PBF Merapi", "PBF Parit Padang"],
}
