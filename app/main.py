"""MedCost web app: FastAPI JSON API + a single static page."""
import json
from pathlib import Path
from typing import Literal

import joblib
import pandas as pd
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from medcost.features import DATA_RANGE, engineer

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "artifacts"
STATIC = Path(__file__).parent / "static"

bundle = joblib.load(ART / "model.joblib")
MODEL, OFFSETS = bundle["model"], bundle["interval_offsets"]
USE_SEX_REGION = bundle["use_sex_region"]
METRICS = json.loads((ART / "metrics.json").read_text())

app = FastAPI(title="MedCost", version="1.0.0")


class Person(BaseModel):
    age: int = Field(ge=0, le=120)
    sex: Literal["male", "female"] = "female"
    bmi: float = Field(ge=10, le=80)
    children: int = Field(ge=0, le=20)
    smoker: Literal["yes", "no"]
    region: Literal["northeast", "northwest", "southeast", "southwest"] = "northeast"


def predict_many(rows: list[dict]) -> list[float]:
    X = engineer(pd.DataFrame(rows), use_sex_region=USE_SEX_REGION)
    return [max(0.0, float(p)) for p in MODEL.predict(X)]


def interval(pred: float, smoker: str) -> tuple[float, float]:
    lo, hi = OFFSETS[smoker]
    return max(0.0, pred + lo), pred + hi


def warnings_for(p: Person) -> list[str]:
    out = []
    for field, (lo, hi) in DATA_RANGE.items():
        v = getattr(p, field)
        if not lo <= v <= hi:
            out.append(f"{field} = {v} is outside the training data ({lo:g}–{hi:g}); "
                       "the estimate is an extrapolation and much less reliable.")
    return out


@app.post("/api/predict")
def predict(p: Person):
    base = p.model_dump()
    scenarios = [("You", base)]
    if p.smoker == "yes":
        scenarios.append(("If you quit smoking", base | {"smoker": "no"}))
    if p.bmi > 25:
        scenarios.append(("If your BMI were 25", base | {"bmi": 25.0}))
    if p.bmi >= 30 and p.smoker == "yes":
        scenarios.append(("Quit smoking and BMI 25", base | {"smoker": "no", "bmi": 25.0}))
    if p.age < 64:
        scenarios.append(("In 10 years", base | {"age": min(p.age + 10, 64)}))

    ages = list(range(18, 65, 2))
    other = "no" if p.smoker == "yes" else "yes"
    preds = predict_many([s for _, s in scenarios]
                         + [base | {"age": a} for a in ages]
                         + [base | {"age": a, "smoker": other} for a in ages])
    k, n = len(scenarios), len(ages)
    you = preds[0]
    lo, hi = interval(you, p.smoker)
    return {
        "prediction": round(you, 2),
        "low": round(lo, 2),
        "high": round(hi, 2),
        "coverage": 1 - bundle["alpha"],
        "warnings": warnings_for(p),
        "what_if": [{"label": lbl, "prediction": round(v, 2), "delta": round(v - you, 2)}
                    for (lbl, _), v in zip(scenarios[1:], preds[1:k])],
        "curve": {"ages": ages, "you": [round(v) for v in preds[k:k + n]],
                  "other": [round(v) for v in preds[k + n:]],
                  "other_label": "smoker" if other == "yes" else "non-smoker"},
        "uses_sex_region": USE_SEX_REGION,
    }


@app.get("/api/metrics")
def metrics():
    return METRICS


@app.get("/healthz")
def healthz():
    return {"ok": True, "model": bundle["name"]}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
