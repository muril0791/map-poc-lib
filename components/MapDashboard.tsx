"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { HeatmapLayer } from "@deck.gl/aggregation-layers";
import { GeoJsonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { CollisionFilterExtension } from "@deck.gl/extensions";
import { FlyToInterpolator, MapController, WebMercatorViewport } from "@deck.gl/core";
import { Map } from "@vis.gl/react-maplibre";
import Supercluster from "supercluster";
import type { MapViewState, PickingInfo, UpdateParameters } from "@deck.gl/core";
import type { CollisionFilterExtensionProps } from "@deck.gl/extensions";
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
  region: string;
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

const COUNTRY_SHARES: [country: string, share: number][] = [
  ["BR", 0.4], ["US", 0.12], ["DE", 0.07], ["GB", 0.06],
  ["CA", 0.04], ["FR", 0.04], ["IN", 0.04], ["JP", 0.04],
  ["ES", 0.03], ["PL", 0.03], ["SG", 0.03],
  ["AR", 0.02], ["AE", 0.02], ["KR", 0.02], ["AU", 0.02], ["ZA", 0.02]
];

type City = [
  name: string,
  country: string,
  lon: number,
  lat: number,
  population: number,
  maxJitter: number,
  region: string
];

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
    const weights = cities.map((city) => Math.pow(city[4], 0.75));
    return { cities, weights, total: weights.reduce((sum, w) => sum + w, 0) };
  });

  for (let i = 0; i < count; i++) {
    const country = countries[pickWeighted(shares, sharesTotal, rand())];
    const [cityName, iso, cityLon, cityLat, population, maxJitter, region] =
      country.cities[pickWeighted(country.weights, country.total, rand())];

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
      region,
      city: cityName,
      events
    });
  }

  return points;
}

function groupBy(points: GeoPoint[], key: (point: GeoPoint) => string) {
  const groups = new globalThis.Map<string, GeoPoint[]>();
  for (const point of points) {
    const group = groups.get(key(point));
    if (group) group.push(point);
    else groups.set(key(point), [point]);
  }
  return [...groups];
}

function summarize(group: GeoPoint[]) {
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
  return {
    count: group.length,
    centroid: [lon / group.length, lat / group.length] as [number, number],
    bounds: [[west, south], [east, north]] as [[number, number], [number, number]]
  };
}

const COUNTRY_MAX_ZOOM = 3;
const STATE_MAX_ZOOM = 6;
const CLUSTER_MAX_ZOOM = 9;
const WORLD_BBOX: [number, number, number, number] = [-180, -85, 180, 85];

type CountryShape = Feature<Polygon | MultiPolygon, { iso: string; name: string; label: [number, number] }>;
type RegionShape = Feature<
  Polygon | MultiPolygon,
  { id: string; iso: string; name: string; label: [number, number] }
>;
type CountryIndex = Supercluster<GeoPoint>;
type Cluster = { id: number; iso: string; position: [number, number]; count: number };
type Total = { count: number; position: [number, number] };

const RAMP: [number, number, number][] = [
  [219, 234, 254],
  [191, 219, 254],
  [147, 197, 253],
  [96, 165, 250],
  [59, 130, 246],
  [37, 99, 235],
  [29, 78, 216],
  [30, 64, 175],
  [30, 58, 138]
];

function rampColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f)) as [number, number, number];
}

function luminance(color: [number, number, number]) {
  const [r, g, b] = color.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const LABEL_NAVY: [number, number, number] = [30, 58, 138];

function prefersWhiteText(fill: [number, number, number]) {
  const l = luminance(fill) + 0.05;
  return 1.05 / l >= l / (luminance(LABEL_NAVY) + 0.05);
}

function logScale(min: number, max: number) {
  const lo = Math.log(min);
  const hi = Math.log(max);
  return (value: number) => (hi === lo ? 1 : (Math.log(value) - lo) / (hi - lo));
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const formatCount = (n: number) => (n < 100000 ? String(n) : compact.format(n));
const formatCompact = (n: number) => (n < 1000 ? String(n) : compact.format(n));

const LABEL_FONT = {
  fontFamily: inter.style.fontFamily,
  fontWeight: 700,
  characterSet: "0123456789.,KMB",
  fontSettings: { sdf: true, fontSize: 96, buffer: 8, radius: 12 }
};

function totalsStyle<T extends Total>(onDark: boolean) {
  return {
    getPosition: (d: T) => d.position,
    getText: (d: T) => formatCount(d.count),
    getColor: onDark ? ([255, 255, 255] as [number, number, number]) : LABEL_NAVY,
    getSize: 14,
    ...LABEL_FONT,
    outlineWidth: onDark ? 2.5 : 0,
    outlineColor: [...LABEL_NAVY, 200] as [number, number, number, number]
  };
}

const LABEL_COLLISION = [new CollisionFilterExtension()];
const STATE_LABEL_COLLISION_TEST = { sizeScale: 2.6 };
const EMPTY_STATE_FILL: [number, number, number] = [239, 246, 255];

const BAND_FADE_MS = 300;
const CLUSTER_FADE_MS = 250;
const BAND_FADE = { opacity: BAND_FADE_MS };
const CLUSTER_FADE = { opacity: CLUSTER_FADE_MS };

const HEAT_COLORS: [number, number, number][] = [
  [147, 197, 253],
  [96, 165, 250],
  [59, 130, 246],
  [29, 78, 216],
  [30, 58, 138]
];

const clusterRadius = (count: number) => 10 + 4 * Math.log10(count);

type ClusterSet = { clusters: Cluster[]; singles: GeoPoint[] };
const NO_CLUSTERS: ClusterSet = { clusters: [], singles: [] };

function clustersAt(countries: { iso: string; index: CountryIndex }[], level: number): ClusterSet {
  const clusters: Cluster[] = [];
  const singles: GeoPoint[] = [];
  for (const country of countries) {
    for (const feature of country.index.getClusters(WORLD_BBOX, level)) {
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
}

class DormantHeatmapLayer extends HeatmapLayer<GeoPoint> {
  static layerName = "DormantHeatmapLayer";

  shouldUpdateState(params: UpdateParameters<this>) {
    return this.props.visible && super.shouldUpdateState(params);
  }
}

function useLinger(active: boolean, ms: number) {
  const [lingering, setLingering] = useState(active);
  useEffect(() => {
    if (active) {
      setLingering(true);
      return;
    }
    const timer = window.setTimeout(() => setLingering(false), ms);
    return () => window.clearTimeout(timer);
  }, [active, ms]);
  return active || lingering;
}

const COLORS: Record<Severity, [number, number, number]> = {
  low: [96, 165, 250],
  medium: [59, 130, 246],
  high: [29, 78, 216],
  critical: [30, 58, 138]
};

const WHEEL_MS = 250;
const WHEEL_EASING = (t: number) => 1 - (1 - t) ** 3;

type ControllerEvent = Parameters<MapController["handleEvent"]>[0];

class StablePinchMapController extends MapController {
  private wheelTarget: { viewState: MapViewState; until: number } | null = null;

  handleEvent(event: ControllerEvent) {
    if (event.type !== "wheel") this.wheelTarget = null;
    if ("device" in event && event.device === "trackpad") {
      this.wheelTarget = null;
      const { scrollZoom } = this;
      this.scrollZoom = { speed: event.srcEvent.ctrlKey ? 0.02 : 0.01, smooth: false };
      try {
        return super.handleEvent(event);
      } finally {
        this.scrollZoom = scrollZoom;
      }
    }
    if (event.type === "wheel") return this.handleMouseWheel(event);
    if (event.type !== "pinchend") return super.handleEvent(event);
    const { inertia, onViewStateChange } = this;
    this.inertia = 0;
    this.onViewStateChange = () => undefined;
    try {
      return super.handleEvent(event);
    } finally {
      this.inertia = inertia;
      this.onViewStateChange = onViewStateChange;
    }
  }

  private handleMouseWheel(event: ControllerEvent) {
    const { props, onViewStateChange } = this;
    const target = this.wheelTarget;
    if (target && performance.now() < target.until) this.props = { ...props, ...target.viewState };
    this.onViewStateChange = (params) => {
      const viewState = params.viewState as MapViewState;
      this.wheelTarget = { viewState, until: performance.now() + WHEEL_MS };
      onViewStateChange({ ...params, viewState: { ...viewState, transitionEasing: WHEEL_EASING } });
    };
    try {
      return super.handleEvent(event);
    } finally {
      this.props = props;
      this.onViewStateChange = onViewStateChange;
    }
  }
}

const MAP_CONTROLLER = {
  type: StablePinchMapController,
  scrollZoom: { smooth: true, speed: 0.01 },
  inertia: 300,
  doubleClickZoom: false
};

const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

const MAPLIBRE = typeof window === "undefined" ? undefined : import("maplibre-gl");

const BASEMAP_PAINT: [layer: string, property: string, value: unknown][] = [
  ["background", "background-color", "#eef1f5"],
  ["water", "fill-color", "#ffffff"],
  ["boundary_country_inner", "line-color", "#93c5fd"],
  ["boundary_state", "line-color", "#93c5fd"],
  ["boundary_state", "line-opacity", ["interpolate", ["linear"], ["zoom"], STATE_MAX_ZOOM - 0.3, 0, STATE_MAX_ZOOM, 1]],
  ["boundary_state", "line-width", ["interpolate", ["linear"], ["zoom"], STATE_MAX_ZOOM, 1, 9, 1.4]],
  ["watername_ocean", "text-halo-color", "#ffffff"],
  ["watername_sea", "text-halo-color", "#ffffff"]
];
const BASEMAP_HIDDEN = [
  "landcover",
  "landuse",
  "park_national_park",
  "park_nature_reserve",
  "waterway",
  "waterway_label",
  "boundary_country_outline",
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
      .catch(() => setCountryShapes([]))
      .finally(() => setShapesReady(true));
  }, []);

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

  const [prewarmLayers, setPrewarmLayers] = useState(false);

  useEffect(() => {
    if (mapLoading || prewarmLayers) return;
    const hasIdle = typeof window.requestIdleCallback === "function";
    const handle = hasIdle
      ? window.requestIdleCallback(() => setPrewarmLayers(true), { timeout: 1000 })
      : window.setTimeout(() => setPrewarmLayers(true), 200);
    return () => (hasIdle ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
  }, [mapLoading, prewarmLayers]);

  const countries = useMemo(
    () =>
      groupBy(points, (p) => p.country).map(([iso, group]) => {
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
        return { iso, ...summarize(group), index };
      }),
    [points]
  );

  const regions = useMemo(
    () => groupBy(points, (p) => p.region).map(([id, group]) => ({ id, ...summarize(group) })),
    [points]
  );

  const regionById = useMemo(() => new globalThis.Map(regions.map((r) => [r.id, r])), [regions]);

  const regionColorScale = useMemo(() => {
    const totals = regions.map((r) => r.count);
    return totals.length ? logScale(Math.min(...totals), Math.max(...totals)) : () => 0;
  }, [regions]);

  const [regionShapes, setRegionShapes] = useState<RegionShape[]>([]);

  useEffect(() => {
    if (mapLoading) return;
    fetch("/states-10m.json")
      .then((response) => response.json())
      .then((collection) => setRegionShapes(collection.features))
      .catch(() => setRegionShapes([]));
  }, [mapLoading]);

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

  const regionShapesWithEvents = useMemo(
    () => regionShapes.filter((shape) => countryByIso.has(shape.properties.iso)),
    [regionShapes, countryByIso]
  );

  const regionLabels = useMemo(() => {
    const labelById = new globalThis.Map(regionShapes.map((s) => [s.properties.id, s.properties.label]));
    return regions.map((r) => ({ ...r, position: labelById.get(r.id) ?? r.centroid }));
  }, [regions, regionShapes]);

  const [flightZoom, setFlightZoom] = useState<number | null>(null);
  const dataZoom = flightZoom ?? viewState.zoom;

  const [heatZoomLevel, setHeatZoomLevel] = useState(Math.floor(INITIAL_VIEW.zoom));
  const zoomRef = useRef(INITIAL_VIEW.zoom);
  const cameraBusyRef = useRef(false);
  const heatZoomTimerRef = useRef<number>(undefined);

  const zoomLevel = Math.floor(dataZoom);
  const countryView = dataZoom < COUNTRY_MAX_ZOOM;
  const stateView = !countryView && dataZoom < STATE_MAX_ZOOM;
  const totalsView = countryView || stateView;
  const clusterView = !totalsView && zoomLevel <= CLUSTER_MAX_ZOOM;

  const showPins = mode !== "heatmap";
  const showHeatmap = mode === "heatmap" || (mode === "both" && !totalsView);
  const showCountries = showPins && countryView;
  const showStates = showPins && stateView;
  const showClusters = showPins && clusterView;
  const showAllPins = showPins && !totalsView && !clusterView;
  const legendTotals = (countryView ? countries : regions).map((total) => total.count);

  const heatVisible = useLinger(showHeatmap, BAND_FADE_MS);
  const countriesVisible = useLinger(showCountries, BAND_FADE_MS);
  const statesVisible = useLinger(showStates, BAND_FADE_MS);
  const allPinsVisible = useLinger(showAllPins, BAND_FADE_MS);

  useEffect(() => {
    if (showHeatmap && !cameraBusyRef.current) setHeatZoomLevel(Math.floor(zoomRef.current));
  }, [showHeatmap]);

  const clusterLevels = useMemo(() => {
    const levels = new globalThis.Map<number, ClusterSet>();
    for (let level = STATE_MAX_ZOOM; level <= CLUSTER_MAX_ZOOM; level++) {
      levels.set(level, clustersAt(countries, level));
    }
    return levels;
  }, [countries]);

  const clusterLevel = Math.min(Math.max(zoomLevel, STATE_MAX_ZOOM), CLUSTER_MAX_ZOOM);
  const clusterSlot = clusterLevel % 2;
  const [slotLevels, setSlotLevels] = useState<(number | null)[]>([null, null]);
  if (slotLevels[clusterSlot] !== clusterLevel) {
    setSlotLevels(slotLevels.map((level, slot) => (slot === clusterSlot ? clusterLevel : level)));
  }
  const slotClusters = slotLevels.map((level) => (level === null ? NO_CLUSTERS : clusterLevels.get(level) ?? NO_CLUSTERS));
  const slotActive = [0, 1].map((slot) => showClusters && slot === clusterSlot);
  const slotVisible = [useLinger(slotActive[0], CLUSTER_FADE_MS), useLinger(slotActive[1], CLUSTER_FADE_MS)];

  const clusterLabels = (() => {
    const viewport = mapSize.width ? new WebMercatorViewport({ ...viewState, ...mapSize }) : null;
    const margin = 40;
    return slotClusters.map(({ clusters }, slot) =>
      !viewport || !slotVisible[slot]
        ? []
        : clusters.flatMap((cluster) => {
            const [x, y] = viewport.project(cluster.position);
            const visible =
              x > -margin && x < mapSize.width + margin && y > -margin && y < mapSize.height + margin;
            return visible
              ? [{ key: `${cluster.iso}-${cluster.id}`, x: Math.round(x), y: Math.round(y), text: formatCompact(cluster.count) }]
              : [];
          })
    );
  })();

  const flyTo = (longitude: number, latitude: number, zoom: number) => {
    setFlightZoom(zoom);
    setViewState((current) => ({
      ...current,
      longitude,
      latitude,
      zoom,
      transitionDuration: 700,
      transitionInterpolator: new FlyToInterpolator(),
      onTransitionEnd: () => setFlightZoom(null),
      onTransitionInterrupt: () => setFlightZoom(null)
    }));
  };

  const zoomToCountry = (iso: string, viewport: PickingInfo["viewport"]) => {
    const country = countryByIso.get(iso);
    if (!country || !viewport) return;
    const target = (viewport as WebMercatorViewport).fitBounds(country.bounds, {
      padding: 60,
      maxZoom: STATE_MAX_ZOOM - 0.5
    });
    flyTo(target.longitude, target.latitude, Math.max(target.zoom, COUNTRY_MAX_ZOOM));
  };

  const zoomToRegion = (id: string, viewport: PickingInfo["viewport"]) => {
    const region = regionById.get(id);
    if (!region || !viewport) return;
    const target = (viewport as WebMercatorViewport).fitBounds(region.bounds, {
      padding: 60,
      maxZoom: CLUSTER_MAX_ZOOM
    });
    flyTo(target.longitude, target.latitude, Math.max(target.zoom, STATE_MAX_ZOOM));
  };

  const countryLabelGroups = useMemo(
    () =>
      [false, true].map((onDark) =>
        countryLabels.filter((d) => prefersWhiteText(rampColor(colorScale(d.count))) === onDark)
      ),
    [countryLabels, colorScale]
  );
  const countryTotalsLayers = () =>
    !labelFontReady ? [] : [false, true].map(
      (onDark, group) =>
        new TextLayer<(typeof countryLabels)[number]>({
          id: `country-totals-${onDark ? "on-dark" : "on-light"}`,
          data: countryLabelGroups[group],
          visible: countriesVisible,
          opacity: showCountries ? 1 : 0,
          transitions: BAND_FADE,
          pickable: showCountries,
          ...totalsStyle<(typeof countryLabels)[number]>(onDark),
          onClick: ({ object, viewport }) => {
            if (object) zoomToCountry(object.iso, viewport);
          }
        })
    );

  const regionLabelGroups = useMemo(
    () =>
      [false, true].map((onDark) =>
        regionLabels.filter((d) => prefersWhiteText(rampColor(regionColorScale(d.count))) === onDark)
      ),
    [regionLabels, regionColorScale]
  );
  const stateTotalsLayers = () =>
    !labelFontReady ? [] : [false, true].map(
      (onDark, group) =>
        new TextLayer<(typeof regionLabels)[number], CollisionFilterExtensionProps<(typeof regionLabels)[number]>>({
          id: `state-totals-${onDark ? "on-dark" : "on-light"}`,
          data: regionLabelGroups[group],
          visible: statesVisible,
          opacity: showStates ? 1 : 0,
          transitions: BAND_FADE,
          pickable: showStates,
          ...totalsStyle<(typeof regionLabels)[number]>(onDark),
          extensions: LABEL_COLLISION,
          collisionEnabled: true,
          collisionGroup: "state-totals",
          getCollisionPriority: (d) => Math.round(100 * Math.log10(d.count)),
          collisionTestProps: STATE_LABEL_COLLISION_TEST,
          onClick: ({ object, viewport }) => {
            if (object) zoomToRegion(object.id, viewport);
          }
        })
    );

  const clusterColor = (count: number) =>
    rampColor(0.625 + 0.375 * Math.min(1, Math.max(0, colorScale(count))));

  const pinStyle = {
    getPosition: (d: GeoPoint) => [d.longitude, d.latitude] as [number, number],
    autoHighlight: true,
    highlightColor: [15, 23, 42, 255] as [number, number, number, number],
    radiusUnits: "pixels" as const,
    getRadius: 4,
    getFillColor: (d: GeoPoint) => COLORS[d.severity],
    stroked: true,
    getLineColor: [255, 255, 255] as [number, number, number],
    lineWidthUnits: "pixels" as const,
    getLineWidth: 1.5,
    onClick: (info: PickingInfo<GeoPoint>) => {
      if (info.object) setSelected(info.object);
    }
  };

  const layers = [
    new DormantHeatmapLayer({
      id: "ip-heatmap",
      data: points,
      visible: heatVisible,
      opacity: showHeatmap ? (mode === "both" ? 0.6 : 1) : 0,
      transitions: BAND_FADE,
      getPosition: (d) => [d.longitude, d.latitude],
      getWeight: (d) => d.weight,
      radiusPixels: Math.min(100, 34 + 16 * Math.max(0, heatZoomLevel - 2)),
      debounceTimeout: 150,
      intensity: 1.25,
      threshold: 0.04,
      colorRange: HEAT_COLORS
    }),
    new GeoJsonLayer<CountryShape["properties"]>({
      id: "country-fill",
      data: shapesWithEvents,
      visible: countriesVisible,
      opacity: showCountries ? 1 : 0,
      transitions: BAND_FADE,
      pickable: showCountries,
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
    new GeoJsonLayer<RegionShape["properties"]>({
      id: "state-fill",
      data: regionShapesWithEvents,
      visible: statesVisible,
      opacity: showStates ? 1 : 0,
      transitions: BAND_FADE,
      pickable: showStates,
      stroked: true,
      filled: true,
      getFillColor: (f) => {
        const count = regionById.get(f.properties.id)?.count;
        return count ? rampColor(regionColorScale(count)) : EMPTY_STATE_FILL;
      },
      getLineColor: [255, 255, 255],
      lineWidthMinPixels: 1,
      onClick: ({ object, viewport }) => {
        if (object) zoomToRegion(object.properties.id, viewport);
      }
    }),
    ...stateTotalsLayers(),
    ...slotClusters.flatMap(({ clusters, singles }, slot) => [
      new ScatterplotLayer<Cluster>({
        id: `cluster-halos-${slot}`,
        data: clusters,
        visible: slotVisible[slot],
        opacity: slotActive[slot] ? 1 : 0,
        transitions: CLUSTER_FADE,
        radiusUnits: "pixels",
        getPosition: (d) => d.position,
        getRadius: (d) => clusterRadius(d.count) + 5,
        getFillColor: (d) => [...clusterColor(d.count), 45]
      }),
      new ScatterplotLayer<Cluster>({
        id: `clusters-${slot}`,
        data: clusters,
        visible: slotVisible[slot],
        opacity: slotActive[slot] ? 1 : 0,
        transitions: CLUSTER_FADE,
        pickable: slotActive[slot],
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
      new ScatterplotLayer<GeoPoint>({
        id: `ip-singles-${slot}`,
        data: singles,
        visible: slotVisible[slot],
        opacity: slotActive[slot] ? 1 : 0,
        transitions: CLUSTER_FADE,
        pickable: slotActive[slot],
        ...pinStyle
      })
    ]),
    new ScatterplotLayer<GeoPoint>({
      id: "ip-points",
      data: points,
      visible: allPinsVisible,
      opacity: showAllPins ? 1 : 0,
      transitions: BAND_FADE,
      pickable: showAllPins,
      ...pinStyle
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
            controller={MAP_CONTROLLER}
            layers={layers}
            pickingRadius={6}
            getCursor={({ isDragging, isHovering }) =>
              isDragging ? "grabbing" : isHovering ? "pointer" : "grab"
            }
            onViewStateChange={(event) => {
              const next = event.viewState as MapViewState;
              zoomRef.current = next.zoom;
              setViewState(next);
            }}
            onInteractionStateChange={({ inTransition, isDragging, isPanning, isRotating, isZooming }) => {
              window.clearTimeout(heatZoomTimerRef.current);
              cameraBusyRef.current = Boolean(inTransition || isDragging || isPanning || isRotating || isZooming);
              if (!cameraBusyRef.current && showHeatmap) {
                heatZoomTimerRef.current = window.setTimeout(
                  () => setHeatZoomLevel(Math.floor(zoomRef.current)),
                  100
                );
              }
            }}
            onAfterRender={() => {
              if (deckRenderedRef.current) return;
              deckRenderedRef.current = true;
              setDeckReady(true);
            }}
          >
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
                if (map.getLayer("boundary_state")) {
                  map.setFilter("boundary_state", [
                    "all",
                    ["match", ["get", "admin_level"], [3, 4], true, false],
                    ["==", ["get", "maritime"], 0]
                  ]);
                  map.moveLayer("boundary_state", "boundary_country_outline");
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

          {clusterLabels.map((labels, slot) => (
            <div
              key={slot}
              className="clusterLabels"
              style={{ opacity: slotActive[slot] ? 1 : 0, transition: `opacity ${CLUSTER_FADE_MS}ms ease` }}
              aria-hidden
            >
              {labels.map((label) => (
                <span
                  key={label.key}
                  className="clusterLabel"
                  style={{ transform: `translate(${label.x}px, ${label.y}px)` }}
                >
                  {label.text}
                </span>
              ))}
            </div>
          ))}

          {showPins && totalsView ? (
            <div className="legend scale">
              <div className="scaleTitle">Events per {countryView ? "country" : "state"} · log scale</div>
              <div className="scaleBar" />
              <div className="scaleLabels">
                <span>{formatCount(Math.min(...legendTotals))}</span>
                <span>{formatCount(Math.max(...legendTotals))}</span>
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
