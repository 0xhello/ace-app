import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ace: {
          bg: "#09090b",
          card: "#111113",
          surface: "#18181b",
          border: "#1e1e24",
          "border-active": "#2a2a35",
          green: "#00ff7f",
          "green-deep": "#00c060",
          "green-dim": "#00ff7f1a",
          red: "#ef4444",
          "red-dim": "#ef44441a",
          muted: "#71717a",
          secondary: "#a1a1aa",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
