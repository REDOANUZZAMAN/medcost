"""Train MedCost and write artifacts/model.joblib + artifacts/metrics.json.

Run:  python train.py

1. Reproduce the original project's number under its own (leaky) protocol.
2. Deduplicate, hold out 20% untouched, compare models with repeated 5-fold CV.
3. Pick the winner. Prefer the variant without sex/region when it is within
   one CV standard deviation, since those features should not set a price.
4. Build 90% prediction intervals with split conformal, calibrated separately
   for smokers and non-smokers (their errors differ by ~3x), and check the
   coverage on the holdout.
"""
import json
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.compose import TransformedTargetRegressor
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, r2_score, root_mean_squared_error
from sklearn.model_selection import KFold, RepeatedKFold, train_test_split

from medcost.features import engineer

ROOT = Path(__file__).parent
RAW_WITH_DUPES = ROOT / "data" / "original_with_duplicates.csv"
DATA = ROOT / "data" / "insurance.csv"
ART = ROOT / "artifacts"
SEED = 42
ALPHA = 0.10  # 90% intervals


def ordinal(df):
    """The original project's encoding, reproduced exactly."""
    return pd.DataFrame({
        "age": df.age, "sex": df.sex.map({"male": 1, "female": 0}), "bmi": df.bmi,
        "children": df.children, "smoker": df.smoker.map({"yes": 1, "no": 0}),
        "region": df.region.map({"southeast": 0, "southwest": 1, "northwest": 2, "northeast": 3}),
    })


def scores(y, p):
    return {"r2": r2_score(y, p), "mae": mean_absolute_error(y, p),
            "rmse": root_mean_squared_error(y, p)}


def gbr(**kw):
    return GradientBoostingRegressor(random_state=SEED, **kw)


CANDIDATES = {
    # name: (estimator, featurizer, description)
    "mean_baseline": (DummyRegressor(), ordinal, "Always predict the average"),
    "linear_original": (LinearRegression(), ordinal, "Original project's linear model"),
    "rf_original": (RandomForestRegressor(random_state=SEED, n_jobs=-1), ordinal,
                    "Original project's model (Random Forest, default settings)"),
    "linear_engineered": (LinearRegression(), engineer,
                          "Linear + smoker x obesity interaction"),
    "rf_engineered": (RandomForestRegressor(n_estimators=400, min_samples_leaf=5,
                                            random_state=SEED, n_jobs=-1), engineer,
                      "Random Forest, tuned, engineered features"),
    "gbr_engineered": (gbr(n_estimators=300, learning_rate=0.03, max_depth=3, subsample=0.8,
                           min_samples_leaf=10), engineer,
                       "Gradient Boosting, engineered features"),
    "gbr_engineered_huber": (gbr(n_estimators=300, learning_rate=0.03, max_depth=3,
                                 subsample=0.8, min_samples_leaf=10, loss="huber"), engineer,
                             "Gradient Boosting, Huber loss (robust to outliers)"),
    "gbr_log_target": (TransformedTargetRegressor(
        gbr(n_estimators=300, learning_rate=0.03, max_depth=3, subsample=0.8,
            min_samples_leaf=10), func=np.log, inverse_func=np.exp), engineer,
        "Gradient Boosting on log(charges)"),
}


def fair(featurizer):
    return (lambda d: engineer(d, use_sex_region=False)) if featurizer is engineer else None


def cv_eval(est, featurizer, df):
    X, y = featurizer(df), df.charges.to_numpy()
    rows = []
    for tr, va in RepeatedKFold(n_splits=5, n_repeats=3, random_state=SEED).split(X):
        m = clone(est).fit(X.iloc[tr], y[tr])
        rows.append(scores(y[va], m.predict(X.iloc[va])))
    r = pd.DataFrame(rows)
    return {k: float(r[k].mean()) for k in r} | {f"{k}_std": float(r[k].std()) for k in r}


def oof_predictions(est, featurizer, df):
    X, y = featurizer(df), df.charges.to_numpy()
    oof = np.zeros(len(df))
    for tr, va in KFold(5, shuffle=True, random_state=SEED).split(X):
        oof[va] = clone(est).fit(X.iloc[tr], y[tr]).predict(X.iloc[va])
    return oof


def conformal_offsets(y, pred, smoker):
    """Per-group residual quantiles -> additive [lo, hi] offsets (finite-sample corrected)."""
    out = {}
    for g in ("yes", "no"):
        r = (y - pred)[smoker == g]
        n = len(r)
        lo_q = max(0.0, np.floor((n + 1) * ALPHA / 2) / n)
        hi_q = min(1.0, np.ceil((n + 1) * (1 - ALPHA / 2)) / n)
        out[g] = [float(np.quantile(r, lo_q)), float(np.quantile(r, hi_q))]
    return out


def main():
    t0 = time.time()
    ART.mkdir(exist_ok=True)
    report = {"dataset": {}, "leak_demo": {}, "cv": {}, "holdout": {}}

    # 1 -- the original protocol, duplicates and all
    raw = pd.read_csv(RAW_WITH_DUPES)
    report["dataset"] = {"rows_in_original_csv": len(raw),
                         "unique_rows": int(len(raw.drop_duplicates())),
                         "duplicate_rows": int(raw.duplicated().sum())}
    Xtr, Xte, ytr, yte = train_test_split(ordinal(raw), raw.charges, test_size=0.2,
                                          random_state=SEED)
    seen = set(map(tuple, pd.concat([Xtr, ytr], axis=1).to_numpy().tolist()))
    leaked = sum(tuple(r) in seen for r in pd.concat([Xte, yte], axis=1).to_numpy().tolist())
    rf = RandomForestRegressor(random_state=SEED, n_jobs=-1).fit(Xtr, ytr)
    report["leak_demo"]["original_protocol"] = scores(yte, rf.predict(Xte)) | {
        "test_rows": len(Xte), "test_rows_also_in_train": leaked}

    # 2 -- honest protocol
    df = pd.read_csv(DATA)
    train, test = train_test_split(df, test_size=0.2, random_state=SEED,
                                   stratify=df.smoker)
    for name, (est, feat, desc) in CANDIDATES.items():
        report["cv"][name] = cv_eval(est, feat, train) | {"description": desc,
                                                          "uses_sex_region": True}
        if fair(feat):
            report["cv"][name + "_no_sex_region"] = cv_eval(est, fair(feat), train) | {
                "description": desc + ", without sex/region", "uses_sex_region": False}
        print(f"{name:28s} MAE {report['cv'][name]['mae']:8,.0f}  R2 {report['cv'][name]['r2']:.3f}")

    # 3 -- choose (lowest CV MAE), then prefer the fair twin if within 1 std
    engineered = [k for k in CANDIDATES if CANDIDATES[k][1] is engineer]
    best = min(engineered, key=lambda k: report["cv"][k]["mae"])
    twin = best + "_no_sex_region"
    use_sex_region = not (report["cv"][twin]["mae"]
                          <= report["cv"][best]["mae"] + report["cv"][best]["mae_std"])
    chosen = best if use_sex_region else twin
    est = CANDIDATES[best][0]
    feat = engineer if use_sex_region else fair(engineer)
    report["chosen"] = {"name": chosen, "base": best, "uses_sex_region": use_sex_region,
                        "description": report["cv"][chosen]["description"]}

    # untouched holdout: original model vs ours
    rf_o = clone(CANDIDATES["rf_original"][0]).fit(ordinal(train), train.charges)
    report["holdout"]["rf_original"] = scores(test.charges, rf_o.predict(ordinal(test)))
    m = clone(est).fit(feat(train), train.charges)
    pred = m.predict(feat(test))
    report["holdout"]["chosen"] = scores(test.charges, pred)

    # 4 -- conformal intervals: calibrate on train OOF, check on holdout
    off = conformal_offsets(train.charges.to_numpy(), oof_predictions(est, feat, train),
                            train.smoker.to_numpy())
    lo = pred + np.array([off[s][0] for s in test.smoker])
    hi = pred + np.array([off[s][1] for s in test.smoker])
    inside = (test.charges.to_numpy() >= lo) & (test.charges.to_numpy() <= hi)
    report["holdout"]["interval"] = {
        "target_coverage": 1 - ALPHA, "coverage": float(inside.mean()),
        "coverage_smokers": float(inside[test.smoker.to_numpy() == "yes"].mean()),
        "coverage_non_smokers": float(inside[test.smoker.to_numpy() == "no"].mean()),
        "n_test": len(test)}

    # final model: refit on all unique rows, recalibrate intervals on all-data OOF
    final = clone(est).fit(feat(df), df.charges)
    final_off = conformal_offsets(df.charges.to_numpy(), oof_predictions(est, feat, df),
                                  df.smoker.to_numpy())
    imp = getattr(final, "feature_importances_", None)
    if imp is not None:
        report["feature_importance"] = dict(sorted(
            zip(feat(df.head(1)).columns, map(float, imp)), key=lambda kv: -kv[1]))
    report["trained_rows"] = len(df)
    report["interval_offsets"] = final_off
    report["seconds"] = round(time.time() - t0, 1)

    joblib.dump({"model": final, "use_sex_region": use_sex_region,
                 "interval_offsets": final_off, "alpha": ALPHA, "name": chosen},
                ART / "model.joblib", compress=3)
    (ART / "metrics.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: report[k] for k in ("dataset", "leak_demo", "chosen", "holdout")},
                     indent=2))


if __name__ == "__main__":
    main()
