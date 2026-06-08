import { tollwayPreset } from "@tollway/theme/preset";
import type { Config } from "tailwindcss";

// Colors come entirely from the shared preset, which maps to the CSS
// variables in @tollway/theme/tokens.css. No hex lives in this app.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  presets: [tollwayPreset as unknown as Partial<Config>],
};

export default config;
