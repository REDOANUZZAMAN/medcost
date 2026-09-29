# MedCost

Medical insurance cost estimates with a 90% range, what-if scenarios, and an honest evaluation.
A rebuild of [611noorsaeed/Medical-Insurance-Cost-Predictor](https://github.com/611noorsaeed/Medical-Insurance-Cost-Predictor).

## What was wrong with the original

The original CSV has 2,772 rows, but only 1,337 of them are unique. After a random split,
80% of the test rows also appear in the training set, so its reported R² of 0.95 comes
partly from the model remembering rows it had already seen.

| Scored on the same untouched test set (unique rows) | R²    | MAE    |
|-----------------------------------------------------|-------|--------|
| Original project, as published (leaky)              | 0.953 | $1,277 |
| Original Random Forest, honest test                 | 0.884 | $2,458 |
| **MedCost**                                         | 0.928 | $1,154 |

## What MedCost does

- Removes duplicates before splitting and holds out 20% (stratified by smoker) before choosing any model.
- Compares 8 models with 5-fold cross-validation repeated 3 times.
- Adds a smoker × obesity feature, the biggest pattern in the data.
- Uses gradient boosting with a Huber loss.
- Drops sex and region from pricing. Removing them cost less than one CV standard deviation of accuracy.
- Gives 90% prediction ranges using split conformal, calibrated separately for smokers and non-smokers. The ranges held 95% of the holdout.
- Shows what-if scenarios (quit smoking, BMI 25, +10 years), an age curve, and warnings for inputs outside the training range.

## Run

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python train.py            # ~3 min; writes artifacts/model.joblib + metrics.json
.venv/bin/uvicorn app.main:app --reload
.venv/bin/python -m pytest -q
```

Docker: `docker build -t medcost . && docker run -p 8000:8000 medcost`. The build uses the aliyun
PyPI mirror by default; pass `--build-arg PIP_INDEX_URL=https://pypi.org/simple` to use PyPI instead.

API: `POST /api/predict` `{"age":45,"bmi":33,"children":2,"smoker":"yes"}` · `GET /api/metrics` · `GET /healthz`.

This is an educational tool trained on a small public US dataset (ages 18–64). It is not a quote and not financial or medical advice.
