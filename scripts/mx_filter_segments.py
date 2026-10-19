#!/usr/bin/env python3
"""Move rows whose email domain has no MX/A record out of the launch segments into HOLD_review.csv."""
import csv, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

D = Path(sys.argv[1] if len(sys.argv) > 1 else "os-data/segments")
LAUNCH = ["A_trades", "B_local_service", "C_professional"]


def has_mail(domain):
    for rec in ("MX", "A"):
        out = subprocess.run(["dig", "+short", "+time=3", "+tries=2", rec, domain],
                             capture_output=True, text=True).stdout.strip()
        if out and not out.startswith(";;"):
            return True
    return False


rows = {s: list(csv.DictReader((D / f"{s}.csv").open(newline=""))) for s in LAUNCH}
domains = sorted({r["email"].split("@")[1] for rs in rows.values() for r in rs})
with ThreadPoolExecutor(16) as ex:
    ok = dict(zip(domains, ex.map(has_mail, domains)))
bad = {d for d, v in ok.items() if not v}
print("domains", len(domains), "no mail record", len(bad), sorted(bad)[:20])

hold_path = D / "HOLD_review.csv"
hold = list(csv.DictReader(hold_path.open(newline="")))
cols = list(hold[0].keys())
for s in LAUNCH:
    keep = [r for r in rows[s] if r["email"].split("@")[1] not in bad]
    moved = [r for r in rows[s] if r["email"].split("@")[1] in bad]
    hold += moved
    with (D / f"{s}.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(keep)
    print(s, len(keep), "kept,", len(moved), "moved")
with hold_path.open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(hold)
