# Databricks notebook source
# MAGIC %md
# MAGIC # Re-serve the expiry-risk model as a probability + what-if scorer
# MAGIC Wrap the trained XGBoost classifier in a pyfunc that returns the 7-day expiry-risk
# MAGIC *probability* (0-1), register v2, create/update the Model Serving endpoint, and
# MAGIC rescore `gold_product_risk` with the real probability. The endpoint powers the
# MAGIC Forecast page's live "what-if" scorer.

# COMMAND ----------
import json, mlflow, pandas as pd
from mlflow.tracking import MlflowClient
from mlflow.pyfunc import PythonModel
from pyspark.sql import functions as F, Window

import os, sys
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
from tempo_config import CATALOG, SCHEMA, SERVING_ENDPOINT, EXPERIMENT_DIR, get_spark  # noqa: E402

spark = get_spark()
MODEL_NAME = f"{CATALOG}.{SCHEMA}.tempo_expiry_risk_clf"
FEATURES = ["days_of_supply", "days_to_expiry", "avg_daily_demand", "on_hand_units",
            "reorder_gap", "shelf_life_days", "in_transit_units", "reserved_units"]
mlflow.set_registry_uri("databricks-uc")
mlflow.set_experiment(f"{EXPERIMENT_DIR}/expiry_risk_experiment")

# COMMAND ----------
# Load the trained xgboost model from v1 explicitly (v1 = the original xgboost model;
# do NOT use @prod here — a prior run may have moved @prod to a pyfunc wrapper version).
# If the model was never registered (e.g. the metastore is at its registered-model quota),
# skip the proba-wrapper + serving endpoint entirely: gold_product_risk is already scored
# by train_expiry_risk, and the app's live what-if degrades gracefully without the endpoint.
booster_uri = f"models:/{MODEL_NAME}/1"
try:
    base = mlflow.xgboost.load_model(booster_uri)
except Exception as e:
    _msg = str(e).splitlines()[0][:160] if str(e) else "model not found"
    print(f"WARN: {MODEL_NAME} is not registered ({_msg}); skipping proba wrapper + "
          f"serving endpoint. gold_product_risk was already produced by train_expiry_risk.")
    _skip = json.dumps({"skipped": True, "reason": "model_not_registered", "endpoint": None})
    try:
        dbutils.notebook.exit(_skip)  # noqa: F821 — provided in notebook runtime
    except NameError:
        print("RESULT", _skip)
    sys.exit(0)


class ProbaWrapper(PythonModel):
    def load_context(self, context):
        import mlflow.xgboost
        self.model = mlflow.xgboost.load_model(context.artifacts["clf"])

    def predict(self, context, model_input):
        import pandas as pd
        X = pd.DataFrame(model_input)[FEATURES].astype("float64")
        proba = self.model.predict_proba(X)[:, 1]
        return pd.DataFrame({"expiry_risk_score": proba})


# log the wrapper with the base model as an artifact. UC requires a signature, so declare
# an ALL-DOUBLE input schema — MLflow safely upcasts incoming ints (JSON / spark) to double,
# and the wrapper also casts to float64 internally, so mixed-type requests still work.
from mlflow.models import ModelSignature
from mlflow.types import Schema, ColSpec
sig = ModelSignature(
    inputs=Schema([ColSpec("double", c) for c in FEATURES]),
    outputs=Schema([ColSpec("double", "expiry_risk_score")]),
)
local_clf = "/tmp/ts_expiry_clf"
mlflow.xgboost.save_model(base, local_clf)
with mlflow.start_run(run_name="proba_wrapper"):
    info = mlflow.pyfunc.log_model(
        name="model",
        python_model=ProbaWrapper(),
        artifacts={"clf": local_clf},
        signature=sig,
        registered_model_name=MODEL_NAME,
    )
client = MlflowClient(registry_uri="databricks-uc")
client.set_registered_model_alias(MODEL_NAME, "prod", info.registered_model_version)
new_version = info.registered_model_version
print("registered proba version:", new_version)

# COMMAND ----------
# Rescore gold_product_risk with the real probability from the @prod wrapper.
inv = spark.table(f"{CATALOG}.{SCHEMA}.fact_inventory")
prod = spark.table(f"{CATALOG}.{SCHEMA}.dim_product").select("product_id", "shelf_life_days")
latest = (inv.join(prod, "product_id")
          .withColumn("reorder_gap", F.col("on_hand_units") - F.col("reorder_point"))
          .withColumn("rn", F.row_number().over(
              Window.partitionBy("dc_id", "product_id").orderBy(F.col("reading_date").desc())))
          .filter(F.col("rn") == 1))
for c in FEATURES:
    latest = latest.withColumn(c, F.col(c).cast("double"))

recent_cut = Window.partitionBy("dc_id", "product_id").orderBy(F.col("reading_date").desc())
stockout14 = (inv.withColumn("rn", F.row_number().over(recent_cut))
              .filter(F.col("rn") <= 14)
              .groupBy("dc_id", "product_id")
              .agg(F.round(F.avg("stockout_flag"), 4).alias("stockout_risk_score")))

predict = mlflow.pyfunc.spark_udf(spark, model_uri=f"models:/{MODEL_NAME}@prod",
                                  env_manager="local", result_type="double")
# brand + division already live on fact_inventory (in `latest`) — only pull product_name here.
labels = (spark.table(f"{CATALOG}.{SCHEMA}.dim_product")
          .select("product_id", "product_name"))
dc = (spark.table(f"{CATALOG}.{SCHEMA}.dim_distribution_center").select("dc_id", "dc_name"))

scored = (latest
          .withColumn("expiry_risk_score", F.round(predict(*[F.col(c) for c in FEATURES]), 4))
          .join(stockout14, ["dc_id", "product_id"], "left")
          .join(labels, "product_id", "left")
          .join(dc, "dc_id", "left")
          .fillna({"stockout_risk_score": 0.0}))
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
n_high = out.filter("expiry_risk_score >= 0.7").count()
print("high expiry-risk (>=0.7):", n_high)

# COMMAND ----------
# Point the serving endpoint at the new version — CREATE it if missing (fresh
# workspace), otherwise UPDATE its config. Idempotent so the bootstrap job can run
# in any workspace where the endpoint doesn't exist yet.
from mlflow.deployments import get_deploy_client
dc_client = get_deploy_client("databricks")
endpoint_config = {
    "served_entities": [{
        "entity_name": MODEL_NAME, "entity_version": new_version,
        "workload_size": "Small", "scale_to_zero_enabled": True,
    }]
}
try:
    dc_client.get_endpoint(SERVING_ENDPOINT)
    dc_client.update_endpoint(SERVING_ENDPOINT, config=endpoint_config)
    print("endpoint update requested for version", new_version)
except Exception:
    dc_client.create_endpoint(name=SERVING_ENDPOINT, config=endpoint_config)
    print("endpoint created and serving version", new_version)

# COMMAND ----------
# `dbutils` only exists in a notebook context; when this runs as a spark_python_task
# just print the result instead of exiting the notebook.
_result = json.dumps({"version": new_version, "high_expiry_risk_ge_0_7": int(n_high)})
try:
    dbutils.notebook.exit(_result)  # noqa: F821 — provided in notebook runtime
except NameError:
    print("RESULT", _result)
