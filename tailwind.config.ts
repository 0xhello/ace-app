import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ace: {
          bg: "#0a0a0f",
          card: "#13131a",
          border: "#1e1e2e",
          gold: "#f59e0b",
          green: "#22c55e",
          red: "#ef4444",
          blue: "#3b82f6",
          muted: "#6b7280",
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
