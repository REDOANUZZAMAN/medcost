"""Feature engineering shared by training and serving, so the two can never drift."""
import pandas as pd

REGIONS = ["northeast", "northwest", "southeast", "southwest"]
RAW_COLUMNS = ["age", "sex", "bmi", "children", "smoker", "region"]

# Range covered by the training data. Predictions outside it are extrapolation.
DATA_RANGE = {"age": (18, 64), "bmi": (15.96, 53.13), "children": (0, 5)}


def engineer(df: pd.DataFrame, use_sex_region: bool = True) -> pd.DataFrame:
    """Raw rows -> model matrix.

    The smoker x obesity interaction is the single biggest structure in this
    dataset (smokers with BMI >= 30 pay roughly double other smokers), so it is
    made explicit rather than left for the model to discover.
    """
    smoker = (df["smoker"] == "yes").astype(int)
    obese = (df["bmi"] >= 30).astype(int)
    out = pd.DataFrame({
        "age": df["age"].astype(float),
        "age_sq": df["age"].astype(float) ** 2,
        "bmi": df["bmi"].astype(float),
        "children": df["children"].astype(float),
        "smoker": smoker,
        "obese": obese,
        "smoker_obese": smoker * obese,
        "smoker_bmi": smoker * df["bmi"].astype(float),
    })
    if use_sex_region:
        out["male"] = (df["sex"] == "male").astype(int)
        for r in REGIONS[1:]:
            out[f"region_{r}"] = (df["region"] == r).astype(int)
    return out
