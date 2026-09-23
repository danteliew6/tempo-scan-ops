# Databricks notebook source
# MAGIC %md
# MAGIC # Tempo Scan ML — Expiry-Risk / Imminent-Stockout classifier
# MAGIC AutoML-style Optuna hyperparameter search for a 7-day "will hit expiry-write-off risk"
# MAGIC classifier over fact_inventory, registered to Unity Catalog, then batch-scored per SKU x DC
# MAGIC into `gold_product_risk` (expiry + stockout risk + recommended action) for the ops app.

# COMMAND ----------
import os, sys, json, mlflow, optuna
import numpy as np
from pyspark.sql import functions as F, Window
from mlflow.tracking import MlflowClient
from xgboost import XGBClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, average_precision_score

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
from tempo_config import CATALOG, SCHEMA, S, EXPERIMENT_DIR, get_spark  # noqa: E402

spark = get_spark()


def _emit(payload):
    """Return the run summary — via dbutils in a notebook, else just print it."""
    try:
        dbutils.notebook.exit(payload)  # noqa: F821 — provided in notebook runtime
    except NameError:
        print("RESULT", payload)


MODEL_NAME = f"{S}.tempo_expiry_risk_clf"
FEATURES = ["days_of_supply", "days_to_expiry", "avg_daily_demand", "on_hand_units",
            "reorder_gap", "shelf_life_days", "in_transit_units", "reserved_units"]
mlflow.set_registry_uri("databricks-uc")
mlflow.set_experiment(f"{EXPERIMENT_DIR}/expiry_risk_experiment")

# COMMAND ----------
# MAGIC %md
# MAGIC ## Build features + forward-looking label (expiry risk within next 7 days)

# COMMAND ----------
inv = spark.table(f"{CATALOG}.{SCHEMA}.fact_inventory")
prod = spark.table(f"{CATALOG}.{SCHEMA}.dim_product").select("product_id", "shelf_life_days")

df = (inv.join(prod, "product_id")
      .withColumn("reorder_gap", F.col("on_hand_units") - F.col("reorder_point"))
      .withColumn("day_idx", F.datediff(F.col("reading_date"), F.lit("2026-01-01"))))

# label = will the SKU x DC hit actionable expiry risk (score >= 0.7) in the NEXT 7 days.
w = Window.partitionBy("dc_id", "product_id").orderBy("day_idx").rangeBetween(1, 7)
df = df.withColumn("future_risk", F.max(F.when(F.col("expiry_risk_score") >= 0.7, 1).otherwise(0)).over(w))
# keep only rows that have a full 7-day forward window
maxidx = Window.partitionBy("dc_id", "product_id")
df = (df.withColumn("max_idx", F.max("day_idx").over(maxidx))
        .filter(F.col("day_idx") <= F.col("max_idx") - 7))

pdf = df.select(*FEATURES, F.col("future_risk").alias("label")).toPandas()
print("training rows:", len(pdf), "| positive rate:", round(pdf.label.mean(), 3))

X, y = pdf[FEATURES], pdf["label"].astype(int)
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.25, stratify=y, random_state=42)
pos_weight = (y_train == 0).sum() / max(1, (y_train == 1).sum())

# COMMAND ----------
# MAGIC %md
# MAGIC ## AutoML-style hyperparameter search (Optuna, nested MLflow runs)

# COMMAND ----------
mlflow.xgboost.autolog(log_input_examples=True, silent=True)


def objective(trial):
    params = {
        "n_estimators": trial.suggest_int("n_estimators", 120, 400),
        "max_depth": trial.suggest_int("max_depth", 3, 9),
        "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
        "subsample": trial.suggest_float("subsample", 0.6, 1.0),
        "colsample_bytree": trial.suggest_float("colsample_bytree", 0.6, 1.0),
        "scale_pos_weight": pos_weight,
        "eval_metric": "logloss",
    }
    with mlflow.start_run(nested=True):
        m = XGBClassifier(**params).fit(X_train, y_train)
        auc = roc_auc_score(y_test, m.predict_proba(X_test)[:, 1])
        mlflow.log_metric("val_auc", auc)
        return auc


with mlflow.start_run(run_name="hpo") as parent:
    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=15)
    mlflow.log_params({f"best_{k}": v for k, v in study.best_params.items()})
print("best val AUC:", round(study.best_value, 4))

# COMMAND ----------
# MAGIC %md
# MAGIC ## Retrain best params and register to Unity Catalog

# COMMAND ----------
model_version = None
with mlflow.start_run(run_name="best"):
    best = XGBClassifier(**study.best_params, scale_pos_weight=pos_weight, eval_metric="logloss").fit(X, y)
    auc = roc_auc_score(y_test, best.predict_proba(X_test)[:, 1])
    ap = average_precision_score(y_test, best.predict_proba(X_test)[:, 1])
    mlflow.log_metrics({"val_auc": auc, "val_avg_precision": ap})
    # Best-effort UC registration (metastore may be at its registered-model quota). The
    # batch scoring below uses the in-memory model, so gold_product_risk is produced
    # regardless; registration only enables the optional serving what-if.
    try:
        info = mlflow.xgboost.log_model(best, name="model", registered_model_name=MODEL_NAME,
                                        input_example=X_train.head(3))
        client = MlflowClient(registry_uri="databricks-uc")
        client.set_registered_model_alias(MODEL_NAME, "prod", info.registered_model_version)
        model_version = info.registered_model_version
        print("registered version:", model_version)
    except Exception as e:
        mlflow.xgboost.log_model(best, name="model", input_example=X_train.head(3))
        print(f"WARN: UC model registration skipped ({str(e).splitlines()[0][:140]}); "
              f"scoring gold_product_risk with the in-memory model.")

# COMMAND ----------
# MAGIC %md
# MAGIC ## Batch score latest reading per SKU x DC -> gold_product_risk

# COMMAND ----------
# latest inventory row per DC x product
latest = (inv.join(prod, "product_id")
          .withColumn("reorder_gap", F.col("on_hand_units") - F.col("reorder_point"))
          .withColumn("rn", F.row_number().over(
              Window.partitionBy("dc_id", "product_id").orderBy(F.col("reading_date").desc())))
          .filter(F.col("rn") == 1))
for c in FEATURES:
    latest = latest.withColumn(c, F.col(c).cast("double"))

# observed stockout frequency over the recent 14 readings = operational stockout-risk score
recent_cut = Window.partitionBy("dc_id", "product_id").orderBy(F.col("reading_date").desc())
stockout14 = (inv.withColumn("rn", F.row_number().over(recent_cut))
              .filter(F.col("rn") <= 14)
              .groupBy("dc_id", "product_id")
              .agg(F.round(F.avg("stockout_flag"), 4).alias("stockout_risk_score")))

# Score with the in-memory model on the driver (latest is small: ~DCs x SKUs rows), so
# this does not depend on a registered/served model (robust to metastore quota limits).
latest_pdf = latest.toPandas()
latest_pdf["expiry_risk_score"] = best.predict_proba(latest_pdf[FEATURES])[:, 1].round(4)
pred_sdf = spark.createDataFrame(
    latest_pdf[["dc_id", "product_id", "expiry_risk_score"]])

# brand + division already live on fact_inventory (in `latest`) — only pull product_name here.
labels = (spark.table(f"{CATALOG}.{SCHEMA}.dim_product")
          .select("product_id", "product_name"))
dc = (spark.table(f"{CATALOG}.{SCHEMA}.dim_distribution_center")
      .select("dc_id", "dc_name"))

scored = (latest.drop("expiry_risk_score")  # raw fact_inventory value; replaced by model score
          .join(pred_sdf, ["dc_id", "product_id"], "left")
          .join(stockout14, ["dc_id", "product_id"], "left")
          .join(labels, "product_id", "left")
          .join(dc, "dc_id", "left")
          .fillna({"stockout_risk_score": 0.0, "expiry_risk_score": 0.0}))

scored = scored.withColumn(
    "recommended_action",
    F.when(F.col("stockout_risk_score") >= 0.5, F.lit("expedite"))
     .when(F.col("expiry_risk_score") >= 0.7, F.lit("redistribute"))
     .when((F.col("expiry_risk_score") >= 0.5) & (F.col("days_to_expiry") < 60), F.lit("promote"))
     .otherwise(F.lit("hold")))

out = scored.select(
    "dc_id", "product_id", "product_name", "brand", "division", "region", "dc_name",
    F.col("expiry_risk_score").cast("double").alias("expiry_risk_score"),
    F.col("stockout_risk_score").cast("double").alias("stockout_risk_score"),
    F.col("days_to_expiry").cast("int").alias("days_to_expiry"),
    F.col("on_hand_units").cast("long").alias("on_hand_units"),
    F.col("days_of_supply").cast("double").alias("days_of_supply"),
    F.col("at_risk_expiry_units").cast("long").alias("at_risk_expiry_units"),
    F.col("avg_daily_demand").cast("double").alias("avg_daily_demand"),
    "recommended_action",
    F.current_timestamp().alias("scored_at"))
out.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{CATALOG}.{SCHEMA}.gold_product_risk")
n_expiry = out.filter("expiry_risk_score >= 0.7").count()
n_stockout = out.filter("stockout_risk_score >= 0.5").count()
print(f"gold_product_risk: expiry-at-risk (>=0.7)={n_expiry}, stockout-at-risk (>=0.5)={n_stockout}")
spark.sql(f"COMMENT ON TABLE {CATALOG}.{SCHEMA}.gold_product_risk IS "
          f"'Per SKU x DC expiry + stockout risk from the tempo_expiry_risk_clf model, with a "
          f"recommended action (expedite/redistribute/promote/hold). Feeds the ops app worklist.'")

# COMMAND ----------
_emit(json.dumps({
    "model_version": model_version,
    "val_auc": round(auc, 4),
    "val_avg_precision": round(ap, 4),
    "expiry_at_risk": int(n_expiry),
    "stockout_at_risk": int(n_stockout),
}))
