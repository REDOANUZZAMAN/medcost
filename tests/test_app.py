import json
from pathlib import Path

import pandas as pd
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
ROOT = Path(__file__).resolve().parent.parent
BASE = {"age": 40, "sex": "female", "bmi": 28.0, "children": 1, "smoker": "no",
        "region": "northeast"}


def post(**kw):
    return client.post("/api/predict", json=BASE | kw)


def test_health():
    assert client.get("/healthz").json()["ok"] is True


def test_prediction_inside_interval():
    d = post().json()
    assert 0 < d["low"] <= d["prediction"] <= d["high"]


def test_smoking_costs_more():
    assert post(smoker="yes").json()["prediction"] > post().json()["prediction"] * 1.5


def test_quit_smoking_what_if_is_cheaper():
    d = post(smoker="yes", bmi=32).json()
    quit_ = next(w for w in d["what_if"] if w["label"] == "If you quit smoking")
    assert quit_["delta"] < 0


def test_sex_and_region_do_not_change_price():
    a = post(sex="male", region="southeast").json()["prediction"]
    b = post(sex="female", region="northwest").json()["prediction"]
    assert a == b


def test_out_of_range_warns():
    assert post(age=80).json()["warnings"]
    assert not post().json()["warnings"]


def test_invalid_input_rejected():
    assert post(bmi=5).status_code == 422
    assert post(smoker="maybe").status_code == 422


def test_training_data_has_no_duplicates():
    assert not pd.read_csv(ROOT / "data" / "insurance.csv").duplicated().any()


def test_metrics_report_the_leak():
    m = json.loads((ROOT / "artifacts" / "metrics.json").read_text())
    assert m["dataset"]["duplicate_rows"] > 0
    assert m["holdout"]["chosen"]["mae"] < m["holdout"]["rf_original"]["mae"]


def test_no_ageing_scenario_at_top_of_range():
    assert all(w["label"] != "In 10 years" for w in post(age=64).json()["what_if"])
