"""Build the population explorer data.

    python build.py                 # all steps (aggregation is cached per raster)
    python build.py boundaries      # admin tables, label raster, map GeoJSON
    python build.py aggregate       # reduce every source raster (slow; cached)
    python build.py web             # bundle.json, map PNGs, outputs/*.csv
"""
import argparse
import os
import time

import pipeline


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("steps", nargs="*", choices=["boundaries", "aggregate", "web"], default=[])
    ap.add_argument("--workers", type=int, default=max(1, min(6, (os.cpu_count() or 2) - 2)))
    ap.add_argument("--sources", nargs="+", help="only aggregate these source ids")
    args = ap.parse_args()
    steps = args.steps or ["boundaries", "aggregate", "web"]
    cfg = pipeline.load_config()
    agg_cfg = cfg
    if args.sources:
        agg_cfg = {**cfg, "sources": [s for s in cfg["sources"] if s["id"] in args.sources]}

    if "boundaries" in steps and not (pipeline.BUILD / "labels.npy").exists() or "boundaries" in args.steps:
        t = time.time(); print("== boundaries"); pipeline.build_boundaries(cfg); print(f"   {time.time() - t:.0f}s")
    if "aggregate" in steps:
        t = time.time(); print("== aggregate"); pipeline.aggregate_all(agg_cfg, args.workers); print(f"   {time.time() - t:.0f}s")
    if "web" in steps:
        t = time.time(); print("== web"); pipeline.build_web(cfg); print(f"   {time.time() - t:.0f}s")


if __name__ == "__main__":
    main()
