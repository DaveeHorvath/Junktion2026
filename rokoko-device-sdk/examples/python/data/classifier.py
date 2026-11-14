"""
Train a PyTorch classifier on lines of the form:
    A,0.12,0.53,...,0.98      (1-char label, then 42 comma-separated floats)
    A0.12,0.53,...,0.98       (label without a comma also works)

Usage:
    python classifier.py train data.txt                # trains, saves model.pt
    python classifier.py predict 0.1,0.2,...,0.42      # one set of 42 floats
    python classifier.py predict --file new.txt        # one set per line
    python classifier.py interactive                   # paste sets, get predictions
"""
import argparse
import sys

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

N_FEATURES = 42
MODEL_PATH = "model_aaron.pt"
# MODEL_PATH = "model.pt"
# MODEL_PATH = "maxwell_model.pt"

# ---------------------------------------------------------------- data
def parse_floats(text):
    vals = [float(v) for v in text.strip().strip(",").split(",") if v.strip()]
    if len(vals) != N_FEATURES:
        raise ValueError(f"expected {N_FEATURES} floats, got {len(vals)}")
    return vals


def load_dataset(path):
    labels, feats = [], []
    with open(path) as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                feats.append(parse_floats(line[1:]))
                labels.append(line[0])
            except ValueError as e:
                print(f"skipping line {n}: {e}", file=sys.stderr)
    if not feats:
        sys.exit("no valid lines found")
    return labels, np.array(feats, dtype=np.float32)


# ---------------------------------------------------------------- model
class Net(nn.Module):
    def __init__(self, n_classes, hidden=128, dropout=0.2):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Linear(N_FEATURES, hidden), nn.BatchNorm1d(hidden), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(hidden, hidden), nn.BatchNorm1d(hidden), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(hidden, n_classes),
        )

    def forward(self, x):
        return self.layers(x)


# ---------------------------------------------------------------- training
def train(path, epochs, batch_size, lr, val_split, model_path):
    labels, X = load_dataset(path)
    classes = sorted(set(labels))
    idx = {c: i for i, c in enumerate(classes)}
    y = np.array([idx[c] for c in labels], dtype=np.int64)
    print(f"{len(X)} samples, {len(classes)} classes: {''.join(classes)}")

    # normalise features (stats saved with the model)
    mean, std = X.mean(0), X.std(0) + 1e-8
    X = (X - mean) / std

    # train/validation split
    rng = np.random.default_rng(0)
    perm = rng.permutation(len(X))
    n_val = int(len(X) * val_split) if len(X) >= 10 else 0
    val_i, tr_i = perm[:n_val], perm[n_val:]

    to_t = lambda a: torch.from_numpy(a)
    train_dl = DataLoader(TensorDataset(to_t(X[tr_i]), to_t(y[tr_i])),
                          batch_size=batch_size, shuffle=True, drop_last=len(tr_i) > batch_size)
    Xv, yv = to_t(X[val_i]), to_t(y[val_i])

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = Net(len(classes)).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    loss_fn = nn.CrossEntropyLoss()

    best_acc, best_state = -1.0, None
    for ep in range(1, epochs + 1):
        model.train()
        total = 0.0
        for xb, yb in train_dl:
            xb, yb = xb.to(device), yb.to(device)
            opt.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            opt.step()
            total += loss.item() * len(xb)
        sched.step()

        if n_val:
            model.eval()
            with torch.no_grad():
                acc = (model(Xv.to(device)).argmax(1).cpu() == yv).float().mean().item()
        else:
            acc = 0.0
        if acc >= best_acc:
            best_acc, best_state = acc, {k: v.cpu().clone() for k, v in model.state_dict().items()}
        if ep % max(1, epochs // 10) == 0 or ep == 1:
            msg = f"epoch {ep:4d}  loss {total / len(tr_i):.4f}"
            print(msg + (f"  val acc {acc:.3f}" if n_val else ""))

    torch.save({"state": best_state, "classes": classes,
                "mean": mean, "std": std}, model_path)
    print(f"saved {model_path}" + (f" (best val acc {best_acc:.3f})" if n_val else ""))


# ---------------------------------------------------------------- prediction
class Predictor:
    def __init__(self, model_path=MODEL_PATH):
        ckpt = torch.load(model_path, weights_only=False)
        self.classes = ckpt["classes"]
        self.mean, self.std = ckpt["mean"], ckpt["std"]
        self.model = Net(len(self.classes))
        self.model.load_state_dict(ckpt["state"])
        self.model.eval()

    def predict(self, features, top_k=3):
        """features: list of 42 floats (or a list of such lists).
        Returns (label, confidence, top_k list) per input."""
        X = np.atleast_2d(np.asarray(features, dtype=np.float32))
        X = (X - self.mean) / self.std
        with torch.no_grad():
            probs = torch.softmax(self.model(torch.from_numpy(X)), dim=1).numpy()
        out = []
        for p in probs:
            order = p.argsort()[::-1][:top_k]
            top = [(self.classes[i], float(p[i])) for i in order]
            out.append((top[0][0], top[0][1], top))
        return out


def show(result):
    label, conf, top = result
    others = ", ".join(f"{l}:{c:.1%}" for l, c in top[1:])
    print(f"prediction: {label}  confidence: {conf:.1%}" + (f"   (next: {others})" if others else ""))


# ---------------------------------------------------------------- CLI
def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("train")
    t.add_argument("data")
    t.add_argument("--epochs", type=int, default=200)
    t.add_argument("--batch-size", type=int, default=64)
    t.add_argument("--lr", type=float, default=1e-3)
    t.add_argument("--val-split", type=float, default=0.2)
    t.add_argument("--model", default=MODEL_PATH)

    p = sub.add_parser("predict")
    p.add_argument("values", nargs="?", help="42 comma-separated floats")
    p.add_argument("--file", help="file with one set of 42 floats per line")
    p.add_argument("--model", default=MODEL_PATH)

    i = sub.add_parser("interactive")
    i.add_argument("--model", default=MODEL_PATH)

    a = ap.parse_args()
    if a.cmd == "train":
        train(a.data, a.epochs, a.batch_size, a.lr, a.val_split, a.model)
    elif a.cmd == "predict":
        pred = Predictor(a.model)
        if a.file:
            with open(a.file) as f:
                for line in filter(str.strip, f):
                    # tolerate a leading label character if present
                    s = line.strip()
                    s = s[1:] if not (s[0].isdigit() or s[0] in "-+.") else s
                    show(pred.predict(parse_floats(s))[0])
        elif a.values:
            show(pred.predict(parse_floats(a.values))[0])
        else:
            sys.exit("give values or --file")
    else:
        pred = Predictor(a.model)
        print("Paste 42 comma-separated floats per line (Ctrl+D / empty line to quit).")
        for line in sys.stdin:
            if not line.strip():
                break
            try:
                show(pred.predict(parse_floats(line))[0])
            except ValueError as e:
                print("error:", e)


if __name__ == "__main__":
    main()