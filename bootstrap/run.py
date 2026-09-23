"""Bootstrap stage runner — the single entrypoint for every serverless job task.

Serverless job environments cannot set arbitrary environment variables (the spec
only supports `client` + `dependencies`). This wrapper bridges that gap: the DABs
job passes the target catalog/schema/etc. as task `parameters` in the form
`--ts-catalog=<x>`, and this runner promotes each into the `TEMPO_*` environment
variable BEFORE importing `tempo_config`. It then executes the requested stage
script exactly as if it had been launched directly (so the stage scripts need no
job-specific code).

Usage (as a spark_python_task):
    bootstrap/run.py <stage> --ts-catalog=<c> --ts-schema=<s> [--ts-...] [extra argv]

`--ts-foo-bar=baz`  ->  os.environ["TEMPO_FOO_BAR"] = "baz"
Any non `--ts-` argv is forwarded to the stage script as its own sys.argv
(e.g. the gen_stream_batch batch size).
"""
import os
import runpy
import sys


def _find_repo_root():
    """Locate the repo root (the dir containing tempo_config.py).

    Serverless spark_python_task exec's this file WITHOUT defining ``__file__``,
    so we can't rely on it. We anchor on ``tempo_config.py`` by probing __file__
    (when present), the CWD, and every sys.path entry plus their parents.
    """
    candidates = []
    try:
        here = os.path.dirname(os.path.abspath(__file__))  # noqa: F821
        candidates.append(os.path.dirname(here))
    except NameError:
        pass
    for seed in [os.getcwd()] + [p for p in sys.path if p]:
        candidates.append(seed)
        candidates.append(os.path.dirname(seed))
    for c in candidates:
        try:
            if c and os.path.exists(os.path.join(c, "tempo_config.py")):
                return os.path.abspath(c)
        except Exception:
            pass
    return os.getcwd()


_REPO_ROOT = _find_repo_root()
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# stage name -> repo-relative script path
STAGES = {
    # data generation
    "gen_dims": "data_gen/gen_dims.py",
    "gen_bronze": "data_gen/gen_bronze.py",
    "gen_facts": "data_gen/gen_facts.py",
    "add_comments": "data_gen/add_comments.py",
    # document intelligence (ai_parse_document over sample docs)
    "build_documents": "documents/build_documents.py",
    # governance + metrics
    "apply_governance": "governance/apply_governance.py",
    "create_metric_views": "bootstrap/create_metric_views.py",
    "build_serving_gold": "bootstrap/build_serving_gold.py",
    # ML
    "train_expiry_risk": "ml/train_expiry_risk.py",
    "stockout_proba": "ml/stockout_proba.py",
    "train_demand_forecast": "ml/train_demand_forecast.py",
    # realtime ingest
    "gen_stream_batch": "jobs/gen_stream_batch.py",
    "rebuild_serving_gold": "jobs/rebuild_serving_gold.py",
    "refresh_synced_tables": "jobs/refresh_synced_tables.py",
}


def main(argv):
    passthrough = []
    for arg in argv:
        if arg.startswith("--ts-") and "=" in arg:
            key, val = arg[len("--ts-"):].split("=", 1)
            env_key = "TEMPO_" + key.upper().replace("-", "_")
            os.environ[env_key] = val
        else:
            passthrough.append(arg)

    if not passthrough:
        raise SystemExit(f"usage: run.py <stage> [--ts-key=val ...] [args]; stages={list(STAGES)}")

    stage = passthrough[0]
    if stage not in STAGES:
        raise SystemExit(f"unknown stage '{stage}'; known: {list(STAGES)}")

    # ML stages log to an MLflow experiment under a workspace dir that must exist.
    if stage in ("train_expiry_risk", "train_demand_forecast", "stockout_proba"):
        exp_dir = os.environ.get("TEMPO_EXPERIMENT_DIR", "/Shared/tempo_scan_ml")
        try:
            from databricks.sdk import WorkspaceClient
            WorkspaceClient().workspace.mkdirs(exp_dir)
            print(f"[bootstrap] ensured MLflow experiment dir {exp_dir}")
        except Exception as e:  # non-fatal; the ML script may still succeed
            print(f"[bootstrap] warn: could not mkdirs {exp_dir}: {e}")

    script = os.path.join(_REPO_ROOT, STAGES[stage])
    print(f"[bootstrap] stage={stage} script={STAGES[stage]} "
          f"catalog={os.environ.get('TEMPO_CATALOG', '(default)')} "
          f"schema={os.environ.get('TEMPO_SCHEMA', '(default)')}")
    # Put the stage script's own directory on sys.path so sibling imports work
    # (e.g. data_gen/gen_dims.py does `from common import ...`). runpy.run_path
    # does not add it automatically. _REPO_ROOT is already on sys.path (for
    # `import tempo_config`).
    script_dir = os.path.dirname(script)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    # Run the stage script as __main__ with its own argv (stage name stripped).
    sys.argv = [script] + passthrough[1:]
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main(sys.argv[1:])
