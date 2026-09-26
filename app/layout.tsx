import type { Metadata } from "next";
import { preconnect, preload } from "react-dom";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import { inter } from "./fonts";

// The basemap loads as a chain (style -> tiles.json -> tiles -> glyphs) that only starts once
// MapLibre runs; these hints let the browser fetch the fixed parts with the HTML instead.
// Options match how MapLibre and our own fetch() request them (CORS, no credentials), so the
// preloaded responses get reused rather than downloaded twice.
const CORS = { crossOrigin: "anonymous" } as const;
const BASEMAP_PRELOADS = [
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  "https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json",
  "https://tiles.basemaps.cartocdn.com/fonts/Montserrat%20Medium,Open%20Sans%20Bold,Noto%20Sans%20Regular,HanWangHeiLight%20Regular,NanumBarunGothic%20Regular/0-255.pbf"
];

export const metadata: Metadata = {
  title: "MAD MAP POC",
  description: "25,000 point geolocation dashboard POC"
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  preconnect("https://tiles.basemaps.cartocdn.com", CORS);
  for (const url of BASEMAP_PRELOADS) preload(url, { as: "fetch", ...CORS });
  preload("/countries-110m.json", { as: "fetch", ...CORS });

  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
