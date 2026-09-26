import { Inter } from "next/font/google";

// Self-hosted by next/font; shared by the page CSS (via --font-inter) and the deck.gl
// TextLayer labels, which need the resolved family name
export const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-inter",
  display: "swap"
});
