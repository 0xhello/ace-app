# NBA Spread Model (v1)

Trains and serves an XGBoost model predicting NBA spread covers using the Kaggle dataset `nba_2008-2025.csv` (Oct 2007 – Jun 2024).

## What it predicts

- `home_covered = 1` if the home team covered the spread
- `home_covered = 0` if the home team did not cover

Pushes are excluded from training and backtests.

## Data notes

The `id_spread` / `id_total` columns in the raw CSV are **post-game result flags** that directly encode who covered the spread. They are intentionally excluded to prevent data leakage.

`h2_spread` is the pre-game 2nd-half spread — a real market line. It is included as a feature (`h2_spread_line`).

## Train

```bash
cd /Users/hp/ai-workspace/ace-app
python3 -m ml.nba_spread.train_spread_model \
  --csv "/path/to/nba_2008-2025.csv"
```

## Backtest results (v1)

| Metric        | Value       |
|---------------|-------------|
| Train rows    | 18,224      |
| Test rows     | 4,556       |
| Accuracy      | 54.2%       |
| ROC-AUC       | 55.9%       |
| Best threshold| 0.58        |
| Win rate @0.58| 55.5%       |
| ROI @0.58     | +5.9%       |
| Bets @0.58    | 2,696       |

Break-even at standard -110 vig is 52.38%.

## Live inference

```python
from ml.nba_spread.inference import predict_games, log_prediction

predictions = predict_games(raw_odds_api_games)
for _, row in predictions.iterrows():
    log_prediction(row.to_dict(), notes="auto-logged")
```

`predict_games()` accepts the same game objects fetched by `odds-api.ts` (with `bookmakers`, `home_team`, `away_team`, `commence_time`).

## Artifacts

- `artifacts/nba_spread_xgb.joblib` — saved model (gitignored — run training to generate)
- `artifacts/feature_columns.json` — ordered feature list
- `artifacts/backtest_metrics.json` — last training run metrics
- `artifacts/latest_team_state.json` — rolling team stats as of last training game

## Performance log

Predictions written by `log_prediction()` go to `model_performance.csv` (gitignored). Use `update_prediction_result(game_id, actual)` to grade resolved games.

## Isolation

This module is NBA-only and does not affect any other sport. The Odds API board continues working unchanged without it.
