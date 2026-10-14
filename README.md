# Ethiopia population explorer

An interactive explorer for the Populace quarterly population rasters of Ethiopia that
compares them with other gridded sources (WorldPop R2025A to start with).

## Open it

Live site: https://aschroedercr.github.io/ethiopia-population-explorer/. It is served from
the `gh-pages` branch, which holds the contents of `app/`. After rebuilding and committing
to `main`, republish with:

```bash
git push origin `git subtree split --prefix app main`:refs/heads/gh-pages --force
```

Locally: double-click `app/index.html`. It needs internet access only for the basemap and the
Leaflet/Plotly libraries. Or serve it:

```bash
python -m http.server 8765 --directory app
```

## What's in it

- **Filters** (one row, scopes everything): primary source, period, comparison source,
  admin level (Region 15 / Zone 107 / Woreda 1,148), map metric, and a 1 km grid layer.
- **Map metrics**: population, density, annualised growth since a base period, comparison
  population, and difference (people or %).
- **Unit panel + time series**: click any unit (map, scatter, or table) to see both
  sources over time.
- **Agreement**: a log-log scatter of unit totals with correlation and error summaries,
  plus 1 km pixel statistics per comparison year: correlation, allocation disagreement,
  and how many people each source puts where the other has none.
- **Tables**: biggest differences, and a sortable/filterable table of every unit with CSV download.

## Data and method

| Source | Native grid | Cadence | Files |
|---|---|---|---|
| Populace | 40 m, World Cylindrical Equal Area (ESRI:54034) | quarterly, 2020Q2–2025Q2 | `../Populace/popmap-ETH-*/ETH_YYYYqN.tif` |
| WorldPop R2025A v1 constrained | 3″ (~100 m), EPSG:4326 | annual, 2020–2025 | `../WorldPop/R2025A_100m_constrained/` |
| Boundaries: OCHA COD-AB v04 (2025) | | | `../Boundaries/OCHA_COD_AB/` |

Each source raster goes through the same steps, whatever its CRS or resolution:

1. Every populated cell's centre is converted to lon/lat.
2. The cell is assigned to the woreda that contains it, using a 3″ label raster of the
   OCHA boundaries. Zones and regions are sums of their woredas. People outside every
   woreda are counted as "outside" (about 0.4% for Populace).
3. The cell is also binned into a common 30″ (~1 km) grid. This keeps totals exact and
   gives a cell-by-cell basis for comparing any two sources.

**Matching dates.** Quarters are dated at mid-quarter and years at 1 July. The comparison
source is linearly interpolated to the selected date when estimates exist on both sides
of it. Otherwise the nearest estimate within 0.25 years is used. For example, WorldPop at
2022Q3 = 87.5% of 2022 + 12.5% of 2023.

## Adding another source (e.g. GHS-POP, LandScan, HRSL, census projections)

1. Put the rasters somewhere under `Ethiopia_Mapping/`. Values must be **people per cell**.
2. Add an entry to `sources` in `config.json`. You need a glob, a regex with named groups
   `year` (and `quarter` or `month`), and the cadence (`year` / `quarter` / `month`).
   Add a `comparisons` pair if you want the 1 km difference maps and pixel statistics.
3. Run `python build.py`. Rasters that are already processed are cached, so only the new
   ones are read.

## Rebuilding

```bash
python build.py
```

Steps: `boundaries` (label raster + map GeoJSON, ~10 s), `aggregate` (~20 s per Populace
quarter, run in parallel), `web` (bundle, PNG layers, CSV). Requires `numpy`, `rasterio`,
`geopandas`, `pyproj`, `Pillow`.

Outputs:
- `app/data/`: what the explorer loads (`bundle.js`/`bundle.json`, `geo.js`, `grid/*.png`)
- `outputs/admin_population_long.csv`: every source × period × admin unit, in long format
- `build/`: intermediate files (label raster, per-raster aggregates, including the 1 km grids as `.npz`)
