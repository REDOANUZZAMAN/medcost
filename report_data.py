"""Build artifacts/report.json: the data behind the /report page's charts.

Run after train.py:  python report_data.py

Reuses train.py's split, model and conformal code, so the holdout predictions
plotted in the report are the same ones summarised in metrics.json.
"""
import json

import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.model_selection import train_test_split

from medcost.features import engineer
from train import ART, CANDIDATES, DATA, RAW_WITH_DUPES, SEED, conformal_offsets, fair, \
    oof_predictions


def main():
    metrics = json.loads((ART / "metrics.json").read_text())
    chosen = metrics["chosen"]
    est = CANDIDATES[chosen["base"]][0]
    feat = engineer if chosen["uses_sex_region"] else fair(engineer)

    raw = pd.read_csv(RAW_WITH_DUPES)
    df = pd.read_csv(DATA)
    train, test = train_test_split(df, test_size=0.2, random_state=SEED, stratify=df.smoker)

    m = clone(est).fit(feat(train), train.charges)
    pred = m.predict(feat(test))
    off = conformal_offsets(train.charges.to_numpy(), oof_predictions(est, feat, train),
                            train.smoker.to_numpy())
    lo = pred + np.array([off[s][0] for s in test.smoker])
    hi = pred + np.array([off[s][1] for s in test.smoker])

    def group_stats(g):
        return {"n": int(len(g)), "mean": float(g.charges.mean()),
                "median": float(g.charges.median())}

    obese = df.bmi >= 30
    report = {
        "points": [{"age": int(r.age), "bmi": float(r.bmi), "charges": round(float(r.charges)),
                    "smoker": r.smoker} for r in df.itertuples()],
        "holdout": [{"actual": round(float(a)), "pred": round(float(p)), "lo": round(float(l)),
                     "hi": round(float(h)), "smoker": s}
                    for a, p, l, h, s in zip(test.charges, pred, lo, hi, test.smoker)],
        "groups": {
            "non_smoker": group_stats(df[df.smoker == "no"]),
            "smoker_bmi_lt_30": group_stats(df[(df.smoker == "yes") & ~obese]),
            "smoker_bmi_ge_30": group_stats(df[(df.smoker == "yes") & obese]),
        },
        "dataset": {
            "rows": len(df), "smoker_share": float((df.smoker == "yes").mean()),
            "age_range": [int(df.age.min()), int(df.age.max())],
            "bmi_range": [float(df.bmi.min()), float(df.bmi.max())],
            "charges_mean": float(df.charges.mean()),
            "charges_median": float(df.charges.median()),
            "raw_rows": len(raw),
        },
    }
    (ART / "report.json").write_text(json.dumps(report, separators=(",", ":")))
    print(f"wrote {ART / 'report.json'}: {len(report['points'])} points, "
          f"{len(report['holdout'])} holdout rows")


if __name__ == "__main__":
    main()
