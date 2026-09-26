# IP Geolocation Map POC

POC em Next.js para avaliar um mapa de segurança com **25.000 geolocalizações sintéticas**, combinando:

- MapLibre GL JS
- deck.gl
- HeatmapLayer
- ScatterplotLayer
- Pins coloridos por severidade
- Filtros de severidade
- Alternância entre Heatmap / Pins / Both
- Click em um ponto para abrir detalhes
- Dados distribuídos em ~1.000 cidades reais de 16 países (`data/cities.json`, Natural Earth, domínio público), sempre em terra
- Sem API key de mapa

## Rodar

```bash
npm install
npm run dev
```

Abra:

```text
http://localhost:3000
```

## Build de produção

```bash
npm run build
npm start
```

## Observação

Os 25.000 pontos são sintéticos e gerados deterministicamente no browser. Não há consultas a IPs reais.

O mapa usa tiles/style público do CARTO. Para produção, troque por um provedor de tiles adequado ao seu ambiente/licença.

O deck.gl está fixado em `~9.3.11` de propósito: com deck.gl 9.4.0 (luma.gl 9.4.x) o primeiro desenho das `ScatterplotLayer` (clusters/pins) derruba o processo de GPU do Chrome (`GPU process exited unexpectedly: exit_code=-1073741819`), os contextos WebGL são perdidos e o mapa fica em branco ao clicar num país ou dar zoom. Antes de subir para 9.4+, teste clicar num país e num cluster no Chrome.

## Onde trocar os dados

A função `makePoints(25000)` em:

```text
components/MapDashboard.tsx
```

pode ser substituída pela resposta real da sua API:

```ts
type GeoPoint = {
  id: number;
  ip: string;
  longitude: number;
  latitude: number;
  weight: number;
  severity: "low" | "medium" | "high" | "critical";
  country: string;
  city: string;
  events: number;
};
```

`country` deve ser o código ISO 3166-1 alfa-2 (ex.: `BR`, `US`): é por ele que a visão por país casa os pontos com os contornos em `public/countries-110m.json`.
