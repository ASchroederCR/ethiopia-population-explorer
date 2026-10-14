"""Processing pipeline for the population data explorer.

Every source raster (any CRS, any resolution, people-per-cell counts) is reduced to
two harmonised products so sources can be compared like-for-like:

  1. Admin totals - each populated cell centre is assigned to a woreda via a
     3 arc-second label raster; zones and regions are rolled up from woredas.
  2. A common 30 arc-second (~1 km) EPSG:4326 grid - each populated cell centre is
     binned into the grid cell that contains it (mass preserving).

Working on cell centres keeps the method CRS-agnostic: the Populace 40 m
equal-area grid and the WorldPop 3 arc-second geographic grid go through the
same code path.
"""
from __future__ import annotations

import glob
import json
import math
import re
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build"
WEB_DATA = ROOT / "app" / "data"
EARTH_R_KM = 6371.0088

# How far (years) an annual/quarterly estimate may be from the target date and
# still be used when the target cannot be bracketed for interpolation.
NEAREST_TOLERANCE_YEARS = 0.25


def load_config() -> dict:
    with open(ROOT / "config.json", encoding="utf-8") as f:
        return json.load(f)


# --------------------------------------------------------------------------- grids

class GeoGrid:
    """A north-up EPSG:4326 grid defined by bounds and a resolution in arc-seconds."""

    def __init__(self, west, south, east, north, res_arcsec):
        self.west, self.south, self.east, self.north = west, south, east, north
        self.res = res_arcsec / 3600.0
        self.width = int(round((east - west) / self.res))
        self.height = int(round((north - south) / self.res))

    def index(self, lon, lat):
        """Row/col of the cells containing lon/lat plus an in-bounds mask."""
        i = np.floor((self.north - lat) / self.res).astype(np.int64)
        j = np.floor((lon - self.west) / self.res).astype(np.int64)
        inside = (i >= 0) & (i < self.height) & (j >= 0) & (j < self.width)
        return i, j, inside

    def row_area_km2(self):
        """Area of one cell in each row (km^2), exact on a sphere."""
        lat_top = self.north - np.arange(self.height) * self.res
        lat_bot = lat_top - self.res
        dlon = math.radians(self.res)
        return EARTH_R_KM ** 2 * dlon * (np.sin(np.radians(lat_top)) - np.sin(np.radians(lat_bot)))

    def transform(self):
        from rasterio.transform import from_origin
        return from_origin(self.west, self.north, self.res, self.res)


def comparison_grid(cfg) -> GeoGrid:
    g = cfg["grid"]
    return GeoGrid(g["west"], g["south"], g["east"], g["north"], g["res_arcsec"])


def label_grid(cfg) -> GeoGrid:
    g = cfg["grid"]
    return GeoGrid(g["west"], g["south"], g["east"], g["north"], cfg["boundaries"]["label_raster_arcsec"])


# --------------------------------------------------------------------------- sources

def period_from_match(m: re.Match, cadence: str) -> dict:
    y = int(m.group("year"))
    if cadence == "quarter":
        q = int(m.group("quarter"))
        return {"id": f"{y}Q{q}", "t": y + (q - 0.5) / 4}
    if cadence == "month":
        mo = int(m.group("month"))
        return {"id": f"{y}-{mo:02d}", "t": y + (mo - 0.5) / 12}
    if cadence == "year":
        return {"id": str(y), "t": y + 0.5}
    raise ValueError(f"unknown cadence {cadence!r}")


def discover_source(src: dict) -> list[dict]:
    """Files for a source, each tagged with its period, sorted in time."""
    pattern = re.compile(src["period_regex"])
    out = []
    for path in glob.glob(str(ROOT / src["glob"])):
        m = pattern.search(Path(path).name)
        if m:
            out.append({**period_from_match(m, src["cadence"]), "path": path})
    return sorted(out, key=lambda p: p["t"])


def match_periods(a_periods: list[dict], t: float) -> list[tuple[int, float]] | None:
    """Weights over A's periods that estimate A at time t.

    Linear interpolation when t is bracketed, otherwise the nearest period if it is
    within NEAREST_TOLERANCE_YEARS. Mirrors matchPeriods() in app/app.js.
    """
    ts = [p["t"] for p in a_periods]
    for k, tk in enumerate(ts):
        if abs(tk - t) < 1e-9:
            return [(k, 1.0)]
    for k in range(len(ts) - 1):
        if ts[k] < t < ts[k + 1]:
            w = (t - ts[k]) / (ts[k + 1] - ts[k])
            return [(k, 1 - w), (k + 1, w)]
    k = int(np.argmin([abs(tk - t) for tk in ts]))
    if abs(ts[k] - t) <= NEAREST_TOLERANCE_YEARS + 1e-9:
        return [(k, 1.0)]
    return None


# --------------------------------------------------------------------------- boundaries

def build_boundaries(cfg) -> None:
    """Admin unit table, the woreda label raster, and simplified web GeoJSON."""
    import geopandas as gpd
    from rasterio.features import rasterize

    BUILD.mkdir(exist_ok=True)
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    levels = cfg["boundaries"]["levels"]
    finest = levels[-1]

    gdfs = {}
    for lv in levels:
        g = gpd.read_file(ROOT / lv["path"]).to_crs(4326)
        g = g.sort_values(lv["pcode"]).reset_index(drop=True)
        g["area_km2"] = g.to_crs("ESRI:54034").area / 1e6
        gdfs[lv["level"]] = g

    # Label raster: value k (1-based) = k-th unit of the finest level, 0 = unassigned.
    fine = gdfs[finest["level"]]
    lg = label_grid(cfg)
    print(f"Rasterising {len(fine)} {finest['name']} units to {lg.width}x{lg.height} label grid...")
    labels = rasterize(
        ((geom, k + 1) for k, geom in enumerate(fine.geometry)),
        out_shape=(lg.height, lg.width),
        transform=lg.transform(),
        fill=0,
        dtype="uint16",
    )
    np.save(BUILD / "labels.npy", labels)

    # Unit table, with each fine unit mapped to its ancestor at every level.
    units = {"levels": []}
    for k, lv in enumerate(levels):
        g = gdfs[lv["level"]]
        up = levels[k - 1]["pcode"] if k > 0 else None
        rows = []
        for _, r in g.iterrows():
            row = {"p": r[lv["pcode"]], "n": r[lv["label"]], "area": round(float(r["area_km2"]), 2)}
            if up:
                row["up"] = r[up]
            rows.append(row)
        units["levels"].append({"level": lv["level"], "name": lv["name"], "units": rows})
    fine_to = {}
    for lv in levels:
        lookup = {p: i for i, p in enumerate(gdfs[lv["level"]][lv["pcode"]])}
        col = lv["pcode"]
        fine_to[lv["level"]] = [lookup[p] for p in fine[col]]
    units["fine_to"] = {str(k): v for k, v in fine_to.items()}
    units["boundaries_label"] = cfg["boundaries"]["label"]
    with open(BUILD / "units.json", "w", encoding="utf-8") as f:
        json.dump(units, f)

    # Simplified GeoJSON for the web map; coverage simplification keeps shared edges.
    for lv in levels:
        g = gdfs[lv["level"]][[lv["pcode"], lv["label"], "geometry"]].copy()
        tol = {1: 0.01, 2: 0.005, 3: 0.002}.get(lv["level"], 0.002)
        try:
            g["geometry"] = g.geometry.simplify_coverage(tol)
        except Exception:
            g["geometry"] = g.geometry.simplify(tol, preserve_topology=True)
        g = g.rename(columns={lv["pcode"]: "p", lv["label"]: "n"})
        g["i"] = range(len(g))
        out = WEB_DATA / f"adm{lv['level']}.geojson"
        out.unlink(missing_ok=True)
        g.to_file(out, driver="GeoJSON", COORDINATE_PRECISION=4)
        print(f"  wrote {out.name} ({out.stat().st_size / 1e6:.1f} MB)")


# --------------------------------------------------------------------------- aggregation

def _file_stamp(path: str) -> str:
    st = Path(path).stat()
    return f"{st.st_size}-{int(st.st_mtime)}"


def aggregate_raster(task: dict) -> str:
    """Reduce one source raster to admin totals and the common grid (runs in a worker)."""
    import rasterio
    from pyproj import Transformer
    from rasterio.windows import Window

    out_path = Path(task["out"])
    stamp = _file_stamp(task["path"])
    if out_path.exists():
        with np.load(out_path) as z:
            if str(z["stamp"]) == stamp:
                return f"cached  {out_path.name}"

    cfg = task["cfg"]
    grid, lgrid = comparison_grid(cfg), label_grid(cfg)
    labels = np.load(BUILD / "labels.npy", mmap_mode="r")
    n_lab = task["n_fine"] + 1

    adm_sum = np.zeros(n_lab)
    adm_cells = np.zeros(n_lab, dtype=np.int64)
    gsum = np.zeros(grid.height * grid.width)
    outside_grid = 0.0

    with rasterio.open(task["path"]) as ds:
        T = ds.transform
        if T.b != 0 or T.d != 0:
            raise ValueError(f"{task['path']}: rotated rasters are not supported")
        to_ll = None
        if ds.crs.to_epsg() != 4326:
            to_ll = Transformer.from_crs(ds.crs, "EPSG:4326", always_xy=True)
        nodata = ds.nodata
        block_h = ds.block_shapes[0][0]
        strip = max(block_h, (24_000_000 // ds.width) // block_h * block_h)
        cols_cache = None

        for row0 in range(0, ds.height, strip):
            h = min(strip, ds.height - row0)
            a = ds.read(1, window=Window(0, row0, ds.width, h))
            valid = np.isfinite(a) & (a > 0)
            if nodata is not None and not np.isnan(nodata):
                valid &= a != nodata
            r, c = np.nonzero(valid)
            if r.size == 0:
                continue
            v = a[r, c].astype(np.float64)
            if cols_cache is None:
                cols_cache = T.c + (np.arange(ds.width) + 0.5) * T.a
            x = cols_cache[c]
            y = T.f + (row0 + r + 0.5) * T.e
            lon, lat = to_ll.transform(x, y) if to_ll else (x, y)

            gi, gj, ing = grid.index(lon, lat)
            gsum += np.bincount(gi[ing] * grid.width + gj[ing], weights=v[ing], minlength=gsum.size)
            outside_grid += float(v[~ing].sum())

            li, lj, inl = lgrid.index(lon, lat)
            lab = np.zeros(v.size, dtype=np.int64)
            lab[inl] = labels[li[inl], lj[inl]]
            adm_sum += np.bincount(lab, weights=v, minlength=n_lab)
            adm_cells += np.bincount(lab, minlength=n_lab)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out_path,
        stamp=stamp,
        adm_sum=adm_sum,
        adm_cells=adm_cells,
        grid=gsum.reshape(grid.height, grid.width).astype(np.float32),
        outside_grid=outside_grid,
    )
    return f"built   {out_path.name}  total={adm_sum.sum() + outside_grid:,.0f}"


def aggregate_all(cfg, workers: int) -> None:
    from multiprocessing import Pool

    with open(BUILD / "units.json", encoding="utf-8") as f:
        n_fine = len(json.load(f)["levels"][-1]["units"])
    tasks = []
    for src in cfg["sources"]:
        files = discover_source(src)
        print(f"{src['id']}: {len(files)} files")
        for p in files:
            tasks.append({
                "cfg": cfg, "path": p["path"], "n_fine": n_fine,
                "out": str(BUILD / "agg" / src["id"] / f"{p['id']}.npz"),
            })
    with Pool(workers) as pool:
        for msg in pool.imap_unordered(aggregate_raster, tasks):
            print("  " + msg, flush=True)


# --------------------------------------------------------------------------- web outputs

# Sequential blue ramp (dataviz reference palette) for density classes.
DENSITY_BREAKS = [5, 25, 100, 250, 1000, 5000]           # people / km^2
DENSITY_COLORS = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]
# Diverging blue (A higher) <-> orange (B higher), gray midpoint. People / km^2.
DIFF_BREAKS = [-500, -50, -5, 5, 50, 500]
DIFF_COLORS = ["#a8461d", "#eb6834", "#f6b99a", "#d9d8d3", "#9ec5f4", "#3987e5", "#184f95"]


def _hex(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def write_class_png(classes: np.ndarray, colors: list[str], grid: GeoGrid, path: Path) -> None:
    """Write a palette PNG reprojected to Web Mercator rows; class 0 is transparent."""
    from PIL import Image

    def merc(lat):
        return np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))

    y_top, y_bot = merc(grid.north), merc(grid.south)
    out_h = int(round(grid.height * (y_top - y_bot) / np.radians(grid.north - grid.south)))
    ys = y_top - (np.arange(out_h) + 0.5) * (y_top - y_bot) / out_h
    lats = np.degrees(2 * np.arctan(np.exp(ys)) - np.pi / 2)
    src_rows = np.clip(((grid.north - lats) / grid.res).astype(int), 0, grid.height - 1)
    img = Image.fromarray(classes[src_rows].astype(np.uint8), mode="P")
    pal = [0, 0, 0] + [c for h in colors for c in _hex(h)]
    img.putpalette(pal + [0] * (768 - len(pal)))
    img.save(path, optimize=True, transparency=0)


def classify(values, breaks, valid):
    cls = np.digitize(values, breaks) + 1
    cls[~valid] = 0
    return cls


def build_web(cfg) -> None:
    import csv

    WEB_DATA.mkdir(parents=True, exist_ok=True)
    (WEB_DATA / "grid").mkdir(exist_ok=True)
    with open(BUILD / "units.json", encoding="utf-8") as f:
        units = json.load(f)
    levels = units["levels"]
    fine_to = {int(k): np.array(v) for k, v in units["fine_to"].items()}
    grid = comparison_grid(cfg)
    area = grid.row_area_km2()[:, None]

    sources_meta, values, grids, national = [], {}, {}, {}
    long_rows = []
    for src in cfg["sources"]:
        periods = discover_source(src)
        periods = [p for p in periods if (BUILD / "agg" / src["id"] / f"{p['id']}.npz").exists()]
        if not periods:
            print(f"  skipping {src['id']}: nothing aggregated")
            continue
        vals = {str(lv["level"]): [] for lv in levels}
        nat = {"total": [], "unassigned": [], "settled_cells": []}
        grids[src["id"]] = []
        for p in periods:
            with np.load(BUILD / "agg" / src["id"] / f"{p['id']}.npz") as z:
                fine = z["adm_sum"][1:]
                nat["total"].append(round(float(z["adm_sum"].sum() + z["outside_grid"])))
                nat["unassigned"].append(round(float(z["adm_sum"][0] + z["outside_grid"])))
                nat["settled_cells"].append(int(z["adm_cells"][1:].sum()))
                g = z["grid"].astype(np.float64)
            grids[src["id"]].append(g)
            for lv in levels:
                n = len(lv["units"])
                agg = np.bincount(fine_to[lv["level"]], weights=fine, minlength=n)
                vals[str(lv["level"])].append([round(float(x)) for x in agg])
                for u, x in zip(lv["units"], agg):
                    long_rows.append([src["id"], p["id"], round(p["t"], 4), lv["level"], u["p"], u["n"], round(float(x), 1)])
            dens = g / area
            write_class_png(classify(dens, DENSITY_BREAKS, g > 0), DENSITY_COLORS, grid,
                            WEB_DATA / "grid" / f"{src['id']}_{p['id']}.png")
        values[src["id"]] = vals
        national[src["id"]] = nat
        sources_meta.append({k: src[k] for k in ("id", "label", "description", "cadence")} |
                            {"periods": [{"id": p["id"], "t": p["t"]} for p in periods]})
        print(f"  {src['id']}: {len(periods)} periods")

    # Pixel-level comparison statistics + difference maps on the common grid.
    meta_by_id = {s["id"]: s for s in sources_meta}
    comparisons = []
    for comp in cfg.get("comparisons", []):
        a, b = comp["a"], comp["b"]
        if a not in meta_by_id or b not in meta_by_id:
            continue
        pairs = []
        for kb, pb in enumerate(meta_by_id[b]["periods"]):
            w = match_periods(meta_by_id[a]["periods"], pb["t"])
            if w is None:
                continue
            ga = sum(wt * grids[a][k] for k, wt in w)
            gb = grids[b][kb]
            pairs.append({"b_period": pb["id"], "a_weights": [[meta_by_id[a]["periods"][k]["id"], wt] for k, wt in w],
                          **grid_stats(ga, gb)})
            diff = (ga - gb) / area
            write_class_png(classify(diff, DIFF_BREAKS, (ga > 0) | (gb > 0)), DIFF_COLORS, grid,
                            WEB_DATA / "grid" / f"diff_{a}__{b}_{pb['id']}.png")
        comparisons.append({"a": a, "b": b, "pairs": pairs})

    bundle = {
        "boundaries": units["boundaries_label"],
        "levels": levels,
        "sources": sources_meta,
        "values": values,
        "national": national,
        "comparisons": comparisons,
        "grid": {"bounds": [[grid.south, grid.west], [grid.north, grid.east]], "res_arcsec": cfg["grid"]["res_arcsec"],
                 "density": {"breaks": DENSITY_BREAKS, "colors": DENSITY_COLORS},
                 "diff": {"breaks": DIFF_BREAKS, "colors": DIFF_COLORS}},
        "nearest_tolerance_years": NEAREST_TOLERANCE_YEARS,
    }
    with open(WEB_DATA / "bundle.json", "w", encoding="utf-8") as f:
        json.dump(bundle, f, separators=(",", ":"))
    with open(WEB_DATA / "bundle.js", "w", encoding="utf-8") as f:
        # Same payload as a script so the explorer also opens straight from disk (file://).
        f.write("window.POP_BUNDLE = ")
        json.dump(bundle, f, separators=(",", ":"))
        f.write(";\n")

    with open(WEB_DATA / "geo.js", "w", encoding="utf-8") as f:
        f.write("window.POP_GEO = {};\n")
        for lv in levels:
            gj = (WEB_DATA / f"adm{lv['level']}.geojson").read_text(encoding="utf-8")
            f.write(f"window.POP_GEO[{lv['level']}] = {gj};\n")

    out_csv = ROOT / "outputs" / "admin_population_long.csv"
    out_csv.parent.mkdir(exist_ok=True)
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["source", "period", "t", "admin_level", "pcode", "name", "population"])
        w.writerows(long_rows)
    print(f"  wrote bundle.json ({(WEB_DATA / 'bundle.json').stat().st_size / 1e6:.1f} MB) and {out_csv.name}")


def grid_stats(ga: np.ndarray, gb: np.ndarray) -> dict:
    """Agreement statistics between two count grids on the same cells."""
    either = (ga > 0) | (gb > 0)
    xa, xb = ga[either], gb[either]
    ta, tb = xa.sum(), xb.sum()
    la, lb = np.log10(1 + xa), np.log10(1 + xb)
    # Allocation disagreement: share of population that would have to move between
    # cells to turn B's (rescaled) distribution into A's.
    alloc = 0.5 * np.abs(xa / ta - xb / tb).sum()
    return {
        "total_a": round(float(ta)), "total_b": round(float(tb)),
        "cells_either": int(either.sum()), "cells_a_only": int(((ga > 0) & (gb <= 0)).sum()),
        "cells_b_only": int(((gb > 0) & (ga <= 0)).sum()),
        "share_a_outside_b": float(xa[xb <= 0].sum() / ta), "share_b_outside_a": float(xb[xa <= 0].sum() / tb),
        "r_log": float(np.corrcoef(la, lb)[0, 1]), "r": float(np.corrcoef(xa, xb)[0, 1]),
        "allocation_disagreement": float(alloc),
    }
