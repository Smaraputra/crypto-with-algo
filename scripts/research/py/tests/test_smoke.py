"""The research image imports and fits each library it pins (Phase 0 smoke)."""

import numpy as np


def test_lightgbm_fits_a_planted_signal():
    import lightgbm as lgb

    rng = np.random.default_rng(7)
    x = rng.normal(size=(2_000, 3))
    y = (x[:, 0] > 0).astype(int)
    model = lgb.LGBMClassifier(n_estimators=20, num_leaves=4, verbose=-1, random_state=7).fit(x, y)
    assert (model.predict(x) == y).mean() > 0.95


def test_ridge_recovers_a_known_slope():
    from sklearn.linear_model import Ridge

    rng = np.random.default_rng(7)
    x = rng.normal(size=(5_000, 1))
    y = 0.5 * x[:, 0] + rng.normal(scale=0.1, size=5_000)
    assert abs(Ridge(alpha=1e-6).fit(x, y).coef_[0] - 0.5) < 0.01


def test_parquet_round_trip(tmp_path):
    import pandas as pd

    frame = pd.DataFrame({"t": np.arange(3, dtype="int64"), "close": [1.0, 2.0, 3.0]})
    path = tmp_path / "x.parquet"
    frame.to_parquet(path)
    assert pd.read_parquet(path).equals(frame)


def test_skfolio_cpcv_oracle_layout():
    """Pins the oracle's split layout before Phase 3 compares the in-house CPCV with it.

    skfolio removes purged_size + embargo_size samples AFTER each test block only
    (observed 2026-10-25, skfolio 1.8.1), so a label-overlap purge before a test
    block has to be compared with matching definitions.
    """
    from skfolio.model_selection import CombinatorialPurgedCV

    cv = CombinatorialPurgedCV(n_folds=6, n_test_folds=2, purged_size=4, embargo_size=24)
    assert (cv.n_splits, cv.n_test_paths) == (15, 5)
    x = np.zeros((600, 1))
    appearances = np.zeros(600, dtype=int)
    for split_number, (train, tests) in enumerate(cv.split(x)):
        test = np.concatenate(tests)
        assert np.intersect1d(train, test).size == 0
        appearances[test] += 1
        if split_number == 0:
            assert [(t.min(), t.max()) for t in tests] == [(0, 99), (100, 199)]
            assert train.min() == 200 + 4 + 24
    assert (appearances == 5).all()
