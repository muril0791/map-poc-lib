"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { HeatmapLayer } from "@deck.gl/aggregation-layers";
import { GeoJsonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { FlyToInterpolator, WebMercatorViewport } from "@deck.gl/core";
import { Map } from "@vis.gl/react-maplibre";
import Supercluster from "supercluster";
import type { MapViewState, PickingInfo } from "@deck.gl/core";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import CITIES from "../data/cities.json";
import { inter } from "../app/fonts";

type Severity = "low" | "medium" | "high" | "critical";

type GeoPoint = {
  id: number;
  ip: string;
  longitude: number;
  latitude: number;
  weight: number;
  severity: Severity;
  country: string;
  city: string;
  events: number;
};

const INITIAL_VIEW: MapViewState = {
  longitude: 8,
  latitude: 28,
  zoom: 1.55,
  pitch: 0,
  bearing: 0
};

// Fraction of all events per country; skewed on purpose, like real threat traffic
const COUNTRY_SHARES: [country: string, share: number][] = [
  ["BR", 0.4], ["US", 0.12], ["DE", 0.07], ["GB", 0.06],
  ["CA", 0.04], ["FR", 0.04], ["IN", 0.04], ["JP", 0.04],
  ["ES", 0.03], ["PL", 0.03], ["SG", 0.03],
  ["AR", 0.02], ["AE", 0.02], ["KR", 0.02], ["AU", 0.02], ["ZA", 0.02]
];

// Natural Earth 10m populated places (public domain), top 100 per country above.
// maxJitter = 80% of the center's distance to the coast (Natural Earth 10m land), in degrees,
// so jittered points never land in the sea
type City = [name: string, country: string, lon: number, lat: number, population: number, maxJitter: number];

// Index drawn with probability proportional to weights[i]
function pickWeighted(weights: number[], total: number, roll: number) {
  let remaining = roll * total;
  for (let i = 0; i < weights.length; i++) {
    if (remaining < weights[i]) return i;
    remaining -= weights[i];
  }
  return weights.length - 1;
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePoints(count: number): GeoPoint[] {
  const rand = mulberry32(25000);
  const points: GeoPoint[] = [];

  const shares = COUNTRY_SHARES.map(([, share]) => share);
  const sharesTotal = shares.reduce((sum, share) => sum + share, 0);
  const countries = COUNTRY_SHARES.map(([iso]) => {
    const cities = (CITIES as City[]).filter((city) => city[1] === iso);
    // population^0.75 keeps the big metros dominant without starving smaller cities
    const weights = cities.map((city) => Math.pow(city[4], 0.75));
    return { cities, weights, total: weights.reduce((sum, w) => sum + w, 0) };
  });

  for (let i = 0; i < count; i++) {
    const country = countries[pickWeighted(shares, sharesTotal, rand())];
    const [cityName, iso, cityLon, cityLat, population, maxJitter] =
      country.cities[pickWeighted(country.weights, country.total, rand())];

    // GeoIP resolves an IP to a city, so each event sits on a real city; the jitter only
    // spreads pins over the urban area (~0.4 km for 100k people, capped at ~3 km and at
    // the distance to the coast)
    const jitter = Math.min(maxJitter, 0.004 * Math.sqrt(population / 100000));
    const angle = rand() * Math.PI * 2;
    const distance = jitter * Math.sqrt(rand());
    const lat = cityLat + Math.sin(angle) * distance;
    const lon = cityLon + (Math.cos(angle) * distance) / Math.cos((cityLat * Math.PI) / 180);

    const severityRoll = rand();
    const severity: Severity =
      severityRoll > 0.965
        ? "critical"
        : severityRoll > 0.84
          ? "high"
          : severityRoll > 0.62
            ? "medium"
            : "low";

    const events =
      severity === "critical"
        ? 600 + Math.floor(rand() * 1400)
        : severity === "high"
          ? 200 + Math.floor(rand() * 700)
          : severity === "medium"
            ? 50 + Math.floor(rand() * 300)
            : 5 + Math.floor(rand() * 100);

    points.push({
      id: i + 1,
      ip: `185.${Math.floor(rand() * 220) + 10}.${Math.floor(rand() * 254) + 1}.${Math.floor(rand() * 254) + 1}`,
      longitude: lon,
      latitude: lat,
      weight: Math.min(1, events / 1600),
      severity,
      country: iso,
      city: cityName,
      events
    });
  }

  return points;
}

// Below COUNTRY_MAX_ZOOM the map shows one total per country; above it the totals split
// into clusters, and past CLUSTER_MAX_ZOOM every point is an individual pin
const COUNTRY_MAX_ZOOM = 3;
const CLUSTER_MAX_ZOOM = 9;
const WORLD_BBOX: [number, number, number, number] = [-180, -85, 180, 85];
// stable empty data, so the hidden pins layer isn't handed a new array every render
const NO_POINTS: GeoPoint[] = [];

// Natural Earth 110m admin-0 countries (public domain), slimmed to iso + label point
type CountryShape = Feature<Polygon | MultiPolygon, { iso: string; name: string; label: [number, number] }>;
type CountryIndex = Supercluster<GeoPoint>;
type Cluster = { id: number; iso: string; position: [number, number]; count: number };

// Sequential blue ramp, few -> many events (same family as the reference map)
const RAMP: [number, number, number][] = [
  [219, 234, 254], // #dbeafe
  [191, 219, 254], // #bfdbfe
  [147, 197, 253], // #93c5fd
  [96, 165, 250], // #60a5fa
  [59, 130, 246], // #3b82f6
  [37, 99, 235], // #2563eb
  [29, 78, 216], // #1d4ed8
  [30, 64, 175], // #1e40af
  [30, 58, 138] // #1e3a8a
];

function rampColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f)) as [number, number, number];
}

// Event counts are heavily skewed, so color follows log(count) between the smallest and largest country
function logScale(min: number, max: number) {
  const lo = Math.log(min);
  const hi = Math.log(max);
  return (value: number) => (hi === lo ? 1 : (Math.log(value) - lo) / (hi - lo));
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
// Plain integers like the reference map; compact only for very large real-data totals
const formatCount = (n: number) => (n < 100000 ? String(n) : compact.format(n));
// cluster bubbles are small, so their counts abbreviate from 1000 (4299 -> 4.3K)
const formatCompact = (n: number) => (n < 1000 ? String(n) : compact.format(n));

// Map labels (country totals, cluster counts)
const LABEL_FONT = {
  fontFamily: inter.style.fontFamily,
  // SDF rendering thins strokes a little, so bold reads as semibold on the map
  fontWeight: 700,
  // only the glyphs the formatters can produce; a larger atlas keeps the SDF edges sharp
  characterSet: "0123456789.,KMB",
  fontSettings: { sdf: true, fontSize: 96, buffer: 8, radius: 12 }
};

// Clusters: size carries the count; color stays in the dark half of the ramp
// (#2563eb -> #1e3a8a) so the white number always has >= 5:1 contrast
const clusterRadius = (count: number) => 10 + 4 * Math.log10(count);

// Severity is ordinal: one blue hue, light -> dark (low -> critical)
const COLORS: Record<Severity, [number, number, number]> = {
  low: [96, 165, 250], // #60a5fa
  medium: [59, 130, 246], // #3b82f6
  high: [29, 78, 216], // #1d4ed8
  critical: [30, 58, 138] // #1e3a8a
};

const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

// Start downloading MapLibre (~270 KB) as soon as this module loads, in parallel with the rest
// of the app, instead of react-maplibre's default lazy import once the map has mounted
// (measured: the download used to start ~600 ms in). Browser only: MapLibre needs `window`.
const MAPLIBRE = typeof window === "undefined" ? undefined : import("maplibre-gl");

// Positron recolored to the dashboard palette: gray land, white sea, light-blue borders
const BASEMAP_PAINT: [layer: string, property: string, value: string][] = [
  ["background", "background-color", "#eef1f5"],
  ["water", "fill-color", "#ffffff"],
  ["boundary_country_inner", "line-color", "#93c5fd"],
  ["boundary_state", "line-color", "#dbeafe"],
  ["watername_ocean", "text-halo-color", "#ffffff"],
  ["watername_sea", "text-halo-color", "#ffffff"]
];
// rivers read as extra borders, and boundary_country_outline is an 8px halo band from zoom 6
const BASEMAP_HIDDEN = [
  "landcover",
  "landuse",
  "park_national_park",
  "park_nature_reserve",
  "waterway",
  "waterway_label",
  "boundary_country_outline",
  // continent names sit right where the country totals go
  "place_continent"
];

export default function MapDashboard() {
  const points = useMemo(() => makePoints(25000), []);
  const [mode, setMode] = useState<"both" | "heatmap" | "pins">("both");
  const [selected, setSelected] = useState<GeoPoint | null>(null);
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW);
  const mapWrapRef = useRef<HTMLDivElement>(null);
  const [mapSize, setMapSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = mapWrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setMapSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // deck.gl doesn't release its WebGL context on unmount (luma.gl keeps it for reuse), so every
  // remount (each edit under dev Fast Refresh) leaked a context plus its GPU buffers and
  // textures: measured +285 MB of JS heap after 25 remounts, until the browser started killing
  // contexts. Release the old canvas' context once it has really left the page (the canvas is
  // still attached during React StrictMode's simulated unmount, which must keep it).
  useEffect(() => {
    const canvas = mapWrapRef.current?.querySelector<HTMLCanvasElement>("#deckgl-overlay");
    return () => {
      window.setTimeout(() => {
        if (canvas && !canvas.isConnected) {
          canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
        }
      });
    };
  }, []);

  const [countryShapes, setCountryShapes] = useState<CountryShape[]>([]);
  // deck.gl rasterizes and caches a glyph atlas the first time a font is used, so the map
  // labels wait for Inter; otherwise the fallback font would stay baked into the atlas
  const [labelFontReady, setLabelFontReady] = useState(false);

  useEffect(() => {
    document.fonts
      .load(`700 16px ${inter.style.fontFamily}`)
      .catch(() => undefined)
      .then(() => setLabelFontReady(true));
  }, []);

  useEffect(() => {
    fetch("/countries-110m.json")
      .then((response) => response.json())
      .then((collection) => setCountryShapes(collection.features))
      // without shapes, totals still show at the centroid of each country's points
      .catch(() => setCountryShapes([]))
      .finally(() => setShapesReady(true));
  }, []);

  // Loading screen: stays until the basemap, the first deck.gl frame (where the WebGL
  // shaders compile), the country shapes and the label font are all ready; the timeout
  // makes sure a failed tile or fetch can never leave it stuck
  const [basemapReady, setBasemapReady] = useState(false);
  const [deckReady, setDeckReady] = useState(false);
  const deckRenderedRef = useRef(false);
  const [shapesReady, setShapesReady] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setLoadTimedOut(true), 10000);
    return () => clearTimeout(timer);
  }, []);

  const mapLoading =
    !loadTimedOut && !(basemapReady && deckReady && shapesReady && labelFontReady);

  // Layers that start hidden (heatmap, clusters, pins) are mounted, which compiles their
  // WebGL shaders, only once the map is on screen and the browser is idle. That keeps the
  // compile work off the critical path of the first paint and still ahead of the first zoom.
  const [prewarmLayers, setPrewarmLayers] = useState(false);

  useEffect(() => {
    if (mapLoading || prewarmLayers) return;
    // Safari has no requestIdleCallback
    const hasIdle = typeof window.requestIdleCallback === "function";
    const handle = hasIdle
      ? window.requestIdleCallback(() => setPrewarmLayers(true), { timeout: 1000 })
      : window.setTimeout(() => setPrewarmLayers(true), 200);
    return () => (hasIdle ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
  }, [mapLoading, prewarmLayers]);

  // One entry per country: event total, bounds for click-to-zoom, and its own cluster
  // index so clusters never mix countries and always add up to the country total
  const countries = useMemo(() => {
    const groups = new globalThis.Map<string, GeoPoint[]>();
    for (const point of points) {
      const group = groups.get(point.country);
      if (group) group.push(point);
      else groups.set(point.country, [point]);
    }

    return [...groups].map(([iso, group]) => {
      let lon = 0, lat = 0;
      let west = 180, south = 90, east = -180, north = -90;
      for (const p of group) {
        lon += p.longitude;
        lat += p.latitude;
        west = Math.min(west, p.longitude);
        east = Math.max(east, p.longitude);
        south = Math.min(south, p.latitude);
        north = Math.max(north, p.latitude);
      }

      const index: CountryIndex = new Supercluster<GeoPoint>({
        radius: 60,
        maxZoom: CLUSTER_MAX_ZOOM
      }).load(
        group.map((p) => ({
          type: "Feature" as const,
          properties: p,
          geometry: { type: "Point" as const, coordinates: [p.longitude, p.latitude] }
        }))
      );

      return {
        iso,
        // each point is one event
        count: group.length,
        centroid: [lon / group.length, lat / group.length] as [number, number],
        bounds: [[west, south], [east, north]] as [[number, number], [number, number]],
        index
      };
    });
  }, [points]);

  const countryByIso = useMemo(
    () => new globalThis.Map(countries.map((c) => [c.iso, c])),
    [countries]
  );

  const colorScale = useMemo(() => {
    const totals = countries.map((c) => c.count);
    return totals.length ? logScale(Math.min(...totals), Math.max(...totals)) : () => 0;
  }, [countries]);

  const shapesWithEvents = useMemo(
    () => countryShapes.filter((shape) => countryByIso.has(shape.properties.iso)),
    [countryShapes, countryByIso]
  );

  const countryLabels = useMemo(() => {
    const labelByIso = new globalThis.Map(countryShapes.map((s) => [s.properties.iso, s.properties.label]));
    return countries.map((c) => ({ ...c, position: labelByIso.get(c.iso) ?? c.centroid }));
  }, [countries, countryShapes]);

  // While a click fly-to is in flight, the data (country/cluster view, cluster split) already
  // follows the destination zoom: clusters split once, at the click, and then drift apart as
  // the camera flies in, instead of popping at every zoom level mid-animation. The heatmap
  // radius instead stays at the starting zoom until landing: a radius change rebuilds the whole
  // weight map, which would stall the first frame of the animation.
  const [flight, setFlight] = useState<{ from: number; to: number } | null>(null);
  const dataZoom = flight?.to ?? viewState.zoom;
  const heatZoomLevel = Math.floor(flight?.from ?? viewState.zoom);

  const zoomLevel = Math.floor(dataZoom);
  const countryView = dataZoom < COUNTRY_MAX_ZOOM;
  const clusterView = !countryView && zoomLevel <= CLUSTER_MAX_ZOOM;

  const { clusters, singles } = useMemo(() => {
    const clusters: Cluster[] = [];
    const singles: GeoPoint[] = [];
    if (!clusterView) return { clusters, singles };

    for (const country of countries) {
      for (const feature of country.index.getClusters(WORLD_BBOX, zoomLevel)) {
        const props = feature.properties;
        if ("cluster" in props) {
          clusters.push({
            id: props.cluster_id,
            iso: country.iso,
            position: feature.geometry.coordinates as [number, number],
            count: props.point_count
          });
        } else {
          singles.push(props);
        }
      }
    }
    return { clusters, singles };
  }, [countries, clusterView, zoomLevel]);

  const pins = countryView ? NO_POINTS : clusterView ? singles : points;
  const showPins = mode !== "heatmap";
  const showHeatmap = mode === "heatmap" || (mode === "both" && !countryView);
  const showCountries = showPins && countryView;
  const showClusters = showPins && clusterView;
  const showPoints = showPins && !countryView;

  // Cluster counts are HTML over the deck.gl bubbles: the browser renders small text far
  // crisper than WebGL. Same projection deck uses (view state + canvas size), snapped to
  // whole pixels so the text never lands on a half pixel.
  const clusterLabels = (() => {
    if (!showPins || !clusterView || !mapSize.width) return [];
    const viewport = new WebMercatorViewport({ ...viewState, ...mapSize });
    const margin = 40;
    return clusters.flatMap((cluster) => {
      const [x, y] = viewport.project(cluster.position);
      const visible =
        x > -margin && x < mapSize.width + margin && y > -margin && y < mapSize.height + margin;
      return visible
        ? [{ key: `${cluster.iso}-${cluster.id}`, x: Math.round(x), y: Math.round(y), text: formatCompact(cluster.count) }]
        : [];
    });
  })();

  const flyTo = (longitude: number, latitude: number, zoom: number) => {
    setFlight({ from: viewState.zoom, to: zoom });
    setViewState((current) => ({
      ...current,
      longitude,
      latitude,
      zoom,
      transitionDuration: 700,
      transitionInterpolator: new FlyToInterpolator(),
      onTransitionEnd: () => setFlight(null),
      // e.g. the user grabs the map mid-flight
      onTransitionInterrupt: () => setFlight(null)
    }));
  };

  const zoomToCountry = (iso: string, viewport: PickingInfo["viewport"]) => {
    const country = countryByIso.get(iso);
    if (!country || !viewport) return;
    const target = (viewport as WebMercatorViewport).fitBounds(country.bounds, {
      padding: 60,
      maxZoom: CLUSTER_MAX_ZOOM
    });
    flyTo(target.longitude, target.latitude, Math.max(target.zoom, COUNTRY_MAX_ZOOM));
  };

  // Country totals sit on the map: white numbers on dark fills get a navy halo, navy numbers
  // on light fills a white one (halo color is per layer, hence two layers). The split is
  // memoized: a new data array on every pan frame would make deck.gl rebuild the text.
  const countryLabelGroups = useMemo(
    () => [false, true].map((onDark) => countryLabels.filter((d) => colorScale(d.count) > 0.5 === onDark)),
    [countryLabels, colorScale]
  );
  const countryTotalsLayers = () =>
    !labelFontReady ? [] : [false, true].map(
      (onDark, group) =>
        new TextLayer<(typeof countryLabels)[number]>({
          id: `country-totals-${onDark ? "on-dark" : "on-light"}`,
          data: countryLabelGroups[group],
          visible: showCountries,
          pickable: true,
          getPosition: (d) => d.position,
          getText: (d) => formatCount(d.count),
          getColor: onDark ? [255, 255, 255] : [30, 58, 138],
          getSize: 14,
          ...LABEL_FONT,
          outlineWidth: 2.5,
          outlineColor: onDark ? [30, 58, 138, 200] : [255, 255, 255, 220],
          onClick: ({ object, viewport }) => {
            if (object) zoomToCountry(object.iso, viewport);
          }
        })
    );

  const clusterColor = (count: number) =>
    rampColor(0.625 + 0.375 * Math.min(1, Math.max(0, colorScale(count))));

  // Every layer stays mounted and is toggled with `visible` (deck.gl's recommended pattern):
  // switching modes/zoom bands doesn't rebuild GPU buffers, and their WebGL shaders compile
  // ahead of the first zoom into clusters (which used to freeze ~220 ms). Until the map is on
  // screen only the visible ones are mounted (see prewarmLayers), to keep first paint fast.
  const layers = [
    new HeatmapLayer<GeoPoint>({
      id: "ip-heatmap",
      data: points,
      visible: showHeatmap,
      getPosition: (d) => [d.longitude, d.latitude],
      getWeight: (d) => d.weight,
      // Points spread apart as you zoom, so the kernel grows with the zoom level to keep a
      // smooth field instead of per-point speckles. Stepped per integer zoom because every
      // radius change rebuilds the weight map.
      radiusPixels: Math.min(100, 34 + 16 * Math.max(0, heatZoomLevel - 2)),
      // in "both" the heatmap is a soft backdrop behind the clusters
      opacity: mode === "both" ? 0.6 : 1,
      // redraw the heat 150 ms after a zoom settles (deck.gl default: 500 ms, which reads as
      // a stale, stretched heatmap that snaps in late)
      debounceTimeout: 150,
      intensity: 1.25,
      threshold: 0.04,
      colorRange: [
        [147, 197, 253], // #93c5fd
        [96, 165, 250], // #60a5fa
        [59, 130, 246], // #3b82f6
        [29, 78, 216], // #1d4ed8
        [30, 58, 138] // #1e3a8a
      ]
    }),
    new GeoJsonLayer<CountryShape["properties"]>({
      id: "country-fill",
      data: shapesWithEvents,
      visible: showCountries,
      pickable: true,
      stroked: true,
      filled: true,
      getFillColor: (f) => rampColor(colorScale(countryByIso.get(f.properties.iso)?.count ?? 1)),
      getLineColor: [147, 197, 253],
      lineWidthMinPixels: 1,
      onClick: ({ object, viewport }) => {
        if (object) zoomToCountry(object.properties.iso, viewport);
      }
    }),
    ...countryTotalsLayers(),
    // soft same-color halo instead of a hard white ring
    new ScatterplotLayer<Cluster>({
      id: "cluster-halos",
      data: clusters,
      visible: showClusters,
      radiusUnits: "pixels",
      getPosition: (d) => d.position,
      getRadius: (d) => clusterRadius(d.count) + 5,
      getFillColor: (d) => [...clusterColor(d.count), 45]
    }),
    new ScatterplotLayer<Cluster>({
      id: "clusters",
      data: clusters,
      visible: showClusters,
      pickable: true,
      autoHighlight: true,
      highlightColor: [15, 23, 42, 255],
      radiusUnits: "pixels",
      getPosition: (d) => d.position,
      getRadius: (d) => clusterRadius(d.count),
      getFillColor: (d) => clusterColor(d.count),
      onClick: ({ object }) => {
        const index = object && countryByIso.get(object.iso)?.index;
        if (!object || !index) return;
        const zoom = Math.min(index.getClusterExpansionZoom(object.id), CLUSTER_MAX_ZOOM + 1);
        flyTo(object.position[0], object.position[1], zoom);
      }
    }),
    // cluster counts are HTML (see clusterLabels): WebGL text is blurry at 11px
    new ScatterplotLayer<GeoPoint>({
      id: "ip-points",
      data: pins,
      visible: showPoints,
      getPosition: (d) => [d.longitude, d.latitude],
      pickable: true,
      autoHighlight: true,
      highlightColor: [15, 23, 42, 255],
      // fixed-size dots at every zoom; severity is carried by color
      radiusUnits: "pixels",
      getRadius: 4,
      getFillColor: (d) => COLORS[d.severity],
      // thin white ring keeps overlapping pins separable
      stroked: true,
      getLineColor: [255, 255, 255],
      lineWidthUnits: "pixels",
      getLineWidth: 1.5,
      onClick: (info: PickingInfo<GeoPoint>) => {
        if (info.object) setSelected(info.object);
      }
    })
  ].filter((layer) => prewarmLayers || layer.props.visible);

  return (
    <main className="shell">
      <header className="topbar">
        <h1>MAD MAP POC</h1>
      </header>

      <section className="mapCard">
        <div className="toolbar">
          <div className="segmented">
            {(["both", "heatmap", "pins"] as const).map((item) => (
              <button
                key={item}
                className={mode === item ? "active" : ""}
                onClick={() => setMode(item)}
              >
                {item === "both" ? "Both" : item === "heatmap" ? "Heatmap" : "Pins"}
              </button>
            ))}
          </div>
        </div>

        <div className="mapWrap" ref={mapWrapRef}>
          <DeckGL
            viewState={viewState}
            // animated wheel zoom instead of jumps, a short glide after a drag, and no
            // double-click zoom: with it on, deck.gl holds every single click ~300 ms (measured
            // 314 ms) to rule out a double click, so clicking a country/cluster/pin felt laggy
            controller={{ scrollZoom: { smooth: true, speed: 0.01 }, inertia: 300, doubleClickZoom: false }}
            layers={layers}
            pickingRadius={6}
            getCursor={({ isDragging, isHovering }) =>
              isDragging ? "grabbing" : isHovering ? "pointer" : "grab"
            }
            onViewStateChange={(event) =>
              setViewState(event.viewState as MapViewState)
            }
            // deck.gl calls this every frame (it must always be a function); flag only the first
            onAfterRender={() => {
              if (deckRenderedRef.current) return;
              deckRenderedRef.current = true;
              setDeckReady(true);
            }}
          >
            {/* No reuseMaps: a reused map keeps the oldest WebGL context, and when remounts
                (dev Fast Refresh) push the page past the browser's ~16 active contexts, the
                oldest one is dropped, blanking the basemap. A fresh map per mount releases its
                context on unmount (MapLibre's remove() loses it explicitly). */}
            <Map
              mapLib={MAPLIBRE}
              mapStyle={BASEMAP_STYLE}
              onLoad={({ target: map }) => {
                for (const [layer, property, value] of BASEMAP_PAINT) {
                  if (map.getLayer(layer)) map.setPaintProperty(layer, property, value);
                }
                for (const layer of BASEMAP_HIDDEN) {
                  if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", "none");
                }
                // Positron has no coastline: outline the ocean polygons in the border color
                // (rivers and lakes stay unoutlined so they don't read as borders)
                if (!map.getLayer("coastline")) {
                  map.addLayer(
                    {
                      id: "coastline",
                      type: "line",
                      source: "carto",
                      "source-layer": "water",
                      filter: ["all", ["==", "$type", "Polygon"], ["==", "class", "ocean"]],
                      paint: {
                        "line-color": "#93c5fd",
                        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 6, 1, 12, 1.4]
                      }
                    },
                    "boundary_country_outline"
                  );
                }
                setBasemapReady(true);
              }}
            />
          </DeckGL>

          <div
            className={mapLoading ? "mapLoading" : "mapLoading done"}
            role="status"
            aria-live="polite"
            aria-busy={mapLoading}
          >
            <div className="spinner" />
            <span>{mapLoading ? "Loading map…" : "Map loaded"}</span>
          </div>

          <div className="clusterLabels" aria-hidden>
            {clusterLabels.map((label) => (
              <span
                key={label.key}
                className="clusterLabel"
                style={{ transform: `translate(${label.x}px, ${label.y}px)` }}
              >
                {label.text}
              </span>
            ))}
          </div>

          {showPins && countryView ? (
            <div className="legend scale">
              <div className="scaleTitle">Events per country · log scale</div>
              <div className="scaleBar" />
              <div className="scaleLabels">
                <span>{formatCount(Math.min(...countries.map((c) => c.count)))}</span>
                <span>{formatCount(Math.max(...countries.map((c) => c.count)))}</span>
              </div>
            </div>
          ) : (
            <div className="legend">
              <span><i className="dot low" /> Low</span>
              <span><i className="dot medium" /> Medium</span>
              <span><i className="dot high" /> High</span>
              <span><i className="dot critical" /> Critical</span>
            </div>
          )}

          {selected && (
            <div className="details">
              <button className="close" onClick={() => setSelected(null)}>×</button>
              <div className="eyebrow">SELECTED IP</div>
              <h2>{selected.ip}</h2>
              <div className="location">{selected.city}, {selected.country}</div>
              <div className={`risk ${selected.severity}`}>{selected.severity}</div>
              <div className="detailGrid">
                <span>Events</span><strong>{selected.events.toLocaleString()}</strong>
                <span>Latitude</span><strong>{selected.latitude.toFixed(4)}</strong>
                <span>Longitude</span><strong>{selected.longitude.toFixed(4)}</strong>
              </div>
            </div>
          )}
        </div>
      </section>

      <footer>
        <span>POC data is synthetic · no real IP addresses are queried</span>
        <span>Map tiles: CARTO · Visualization: MapLibre + deck.gl</span>
      </footer>
    </main>
  );
}
