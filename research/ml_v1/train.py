"""ml-v1 (Fase 5, itens 1-2): XGBoost x regressão logística sobre o dataset de `pnpm ml:dataset`.

Uso (de research/):  uv run python ml_v1/train.py ../data/ml/dataset.csv ../data/reports/ml-v1.txt

- Divisão POR TEMPO e POR TOKEN: tokens ordenados pela criação; os 60% mais antigos = treino, os 20%
  seguintes = validação, os 20% mais novos = teste (usado uma vez, no fim). Nenhum mint em dois conjuntos.
- XGBoost (binary:logistic, rótulo "bateu +40% antes de -20%") com early stopping na validação (AUC).
  Baseline: regressão logística (mediana para NaN + padronização).
- Métricas: AUC; precisão (taxa de acerto) no top 1%/5% das amostras; e o que importa — retorno líquido
  médio simulado operando só acima de um limiar de probabilidade: em cada token, a PRIMEIRA amostra com
  p >= limiar vira a operação (um trade por token), retorno = `net_return` simulado daquela amostra.
  Limiar escolhido na VALIDAÇÃO (maior retorno médio com >= MIN_TRADES operações); aplicado ao teste uma vez.
  IC 95% por bootstrap (reamostragem de operações = de tokens, um trade por token).
- Importância: ganho do XGBoost e SHAP (contribuições exatas do próprio XGBoost, `pred_contribs`).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import polars as pl
import xgboost as xgb
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

SEED = 7
MIN_TRADES = 30
META = ["block", "mint", "created_at_ms", "t_ms", "hit_tp", "net_return", "exit_reason", "hold_sec"]


def split_by_token_time(df: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame, dict]:
    toks = df.group_by("mint").agg(pl.col("created_at_ms").min()).sort(["created_at_ms", "mint"])
    n = toks.height
    a, b = int(n * 0.6), int(n * 0.8)
    sets = {"train": toks[:a], "val": toks[a:b], "test": toks[b:]}
    out = {k: df.join(v.select("mint"), on="mint", how="semi") for k, v in sets.items()}
    bounds = {k: (int(v["created_at_ms"].min()), int(v["created_at_ms"].max()), v.height) for k, v in sets.items()}
    return out["train"], out["val"], out["test"], bounds


def bootstrap_ci(x: np.ndarray, rng: np.random.Generator, n: int = 5000) -> tuple[float, float]:
    if len(x) == 0:
        return (float("nan"), float("nan"))
    idx = rng.integers(0, len(x), size=(n, len(x)))
    means = x[idx].mean(axis=1)
    return (float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5)))


def trades_above(df: pl.DataFrame, p: np.ndarray, thr: float) -> np.ndarray:
    """Primeira amostra (por t) de cada token com p >= thr; devolve os net_return dessas operações."""
    d = df.with_columns(pl.Series("p", p)).filter(pl.col("p") >= thr).sort(["mint", "t_ms"])
    first = d.group_by("mint", maintain_order=True).first()
    return first["net_return"].to_numpy()


def precision_top(y: np.ndarray, p: np.ndarray, frac: float) -> float:
    k = max(1, int(len(p) * frac))
    top = np.argsort(-p)[:k]
    return float(y[top].mean())


def choose_threshold(df: pl.DataFrame, p: np.ndarray) -> tuple[float, int, float]:
    best = (float("nan"), 0, float("-inf"))
    for q in [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.98, 0.99, 0.995]:
        thr = float(np.quantile(p, q))
        r = trades_above(df, p, thr)
        if len(r) >= MIN_TRADES and r.mean() > best[2]:
            best = (thr, len(r), float(r.mean()))
    return best


def main() -> None:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    rng = np.random.default_rng(SEED)
    df = pl.read_csv(src, infer_schema_length=10000, null_values=[""])
    feats = [c for c in df.columns if c not in META]
    tr, va, te, bounds = split_by_token_time(df)
    assert not (set(tr["mint"]) & set(te["mint"])) and not (set(tr["mint"]) & set(va["mint"])) and not (set(va["mint"]) & set(te["mint"]))
    X = {k: d.select(feats).to_numpy().astype(np.float64) for k, d in (("train", tr), ("val", va), ("test", te))}
    y = {k: d["hit_tp"].to_numpy() for k, d in (("train", tr), ("val", va), ("test", te))}
    D = {"train": tr, "val": va, "test": te}

    pos = y["train"].mean()
    clf = xgb.XGBClassifier(
        n_estimators=2000, learning_rate=0.03, max_depth=4, min_child_weight=20, subsample=0.8, colsample_bytree=0.8,
        reg_lambda=5.0, eval_metric="auc", early_stopping_rounds=100, random_state=SEED, tree_method="hist",
        scale_pos_weight=(1 - pos) / max(pos, 1e-9),
    )
    clf.fit(X["train"], y["train"], eval_set=[(X["val"], y["val"])], verbose=False)
    logit = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(max_iter=3000, C=0.5))
    logit.fit(X["train"], y["train"])

    lines: list[str] = []
    w = lines.append
    w("ml-v1 — XGBoost x regressão logística (Fase 5, itens 1-2) — dataset de `pnpm ml:dataset`")
    w(f"dataset: {src} · {df.height} amostras · {df['mint'].n_unique()} tokens · {len(feats)} features")
    for k, (lo, hi, n) in bounds.items():
        w(f"  {k:5s}: {n} tokens criados {np.datetime64(lo, 'ms')} → {np.datetime64(hi, 'ms')} UTC · {D[k].height} amostras · taxa +40%-antes-de-−20% {y[k].mean():.3f} · net_return médio {D[k]['net_return'].mean():+.4f}")
    w(f"XGBoost: melhor iteração {clf.best_iteration} (early stopping na validação, AUC)")
    w("")
    results: dict = {"models": {}}
    for name, model in (("xgboost", clf), ("logistica", logit)):
        p = {k: model.predict_proba(X[k])[:, 1] for k in X}
        thr, n_val, mean_val = choose_threshold(va, p["val"])
        r_test = trades_above(te, p["test"], thr) if np.isfinite(thr) else np.array([])
        r_val = trades_above(va, p["val"], thr) if np.isfinite(thr) else np.array([])
        ci_val = bootstrap_ci(r_val, rng)
        ci_test = bootstrap_ci(r_test, rng)
        m = {
            "auc": {k: float(roc_auc_score(y[k], p[k])) for k in ("train", "val", "test")},
            "prec_top1": {k: precision_top(y[k], p[k], 0.01) for k in ("val", "test")},
            "prec_top5": {k: precision_top(y[k], p[k], 0.05) for k in ("val", "test")},
            "threshold": thr,
            "val": {"trades": int(len(r_val)), "mean": float(r_val.mean()) if len(r_val) else None, "ci95": ci_val},
            "test": {"trades": int(len(r_test)), "mean": float(r_test.mean()) if len(r_test) else None, "ci95": ci_test,
                     "hit": float((r_test > 0).mean()) if len(r_test) else None, "sum_sol": float(r_test.sum() * 0.05) if len(r_test) else None},
        }
        results["models"][name] = m
        w(f"[{name}] AUC treino {m['auc']['train']:.3f} · validação {m['auc']['val']:.3f} · TESTE {m['auc']['test']:.3f}")
        w(f"  precisão top 1%: val {m['prec_top1']['val']:.3f} · teste {m['prec_top1']['test']:.3f} | top 5%: val {m['prec_top5']['val']:.3f} · teste {m['prec_top5']['test']:.3f}")
        w(f"  limiar (escolhido na validação, >= {MIN_TRADES} operações, 1 por token): p >= {thr:.4f}")
        w(f"  validação: {m['val']['trades']} operações, retorno líquido médio {m['val']['mean'] if m['val']['mean'] is None else f'{m['val']['mean']:+.4f}'} IC95% [{ci_val[0]:+.4f}; {ci_val[1]:+.4f}]")
        tm = m["test"]["mean"]
        w(f"  TESTE:     {m['test']['trades']} operações, retorno líquido médio {'n/d' if tm is None else f'{tm:+.4f}'} IC95% [{ci_test[0]:+.4f}; {ci_test[1]:+.4f}] · acerto {m['test']['hit'] if m['test']['hit'] is None else f'{m['test']['hit']:.2f}'} · soma (0,05 SOL/op) {m['test']['sum_sol'] if m['test']['sum_sol'] is None else f'{m['test']['sum_sol']:+.4f} SOL'}")
        w("")

    # referências sem modelo
    for k in ("val", "test"):
        allr = trades_above(D[k], np.ones(D[k].height), 0.5)
        w(f"referência sem modelo ({k}): primeira amostra de cada token → {len(allr)} operações, retorno médio {allr.mean():+.4f}")
    w("")

    # importância
    booster = clf.get_booster()
    gain = booster.get_score(importance_type="gain")
    named = sorted(((feats[int(k[1:])], v) for k, v in gain.items()), key=lambda x: -x[1])
    contrib = booster.predict(xgb.DMatrix(X["test"]), pred_contribs=True, iteration_range=(0, clf.best_iteration + 1))
    shap_mean = np.abs(contrib[:, :-1]).mean(axis=0)
    shap_rank = sorted(zip(feats, shap_mean), key=lambda x: -x[1])
    w("Importância — XGBoost ganho (top 15):")
    for f, v in named[:15]:
        w(f"  {f:32s} {v:9.2f}")
    w("Importância — SHAP médio |contribuição| no teste (top 15):")
    for f, v in shap_rank[:15]:
        w(f"  {f:32s} {v:9.4f}")
    lr = logit[-1]
    coef = sorted(zip(feats, lr.coef_[0]), key=lambda x: -abs(x[1]))
    w("Regressão logística — maiores |coeficientes| (features padronizadas, top 10):")
    for f, v in coef[:10]:
        w(f"  {f:32s} {v:+.3f}")
    results["importance"] = {"gain": named[:30], "shap": [(f, float(v)) for f, v in shap_rank[:30]], "logit": [(f, float(v)) for f, v in coef[:30]]}

    xg = results["models"]["xgboost"]["test"]
    ok = xg["mean"] is not None and xg["trades"] > 0 and xg["ci95"][0] > 0
    results["gate_passed"] = ok
    w("")
    w(f"CRITÉRIO (retorno líquido no TESTE > 0 com IC 95% acima de zero, XGBoost): {'CUMPRIDO' if ok else 'NÃO cumprido'}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text("\n".join(lines) + "\n", encoding="utf-8")
    dst.with_suffix(".json").write_text(json.dumps(results, indent=1, default=float), encoding="utf-8")
    clf.save_model(str(dst.with_suffix(".xgb.json")))
    sys.stdout.reconfigure(encoding="utf-8")  # console do Windows (cp1252)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
