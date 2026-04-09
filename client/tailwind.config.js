import tailwindcssAnimate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  /** Matches `<html data-theme="dark">` set in `App.tsx` (and `/shop` bootstrap in `main.tsx`). */
  darkMode: ["selector", '[data-theme="dark"]'],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* Scoped to [data-storefront] via CSS variables (public shop only). */
        storefront: {
          background: "hsl(var(--sf-background))",
          foreground: "hsl(var(--sf-foreground))",
          card: "hsl(var(--sf-card))",
          "card-foreground": "hsl(var(--sf-card-foreground))",
          muted: "hsl(var(--sf-muted))",
          "muted-foreground": "hsl(var(--sf-muted-foreground))",
          border: "hsl(var(--sf-border))",
          input: "hsl(var(--sf-input))",
          primary: "hsl(var(--sf-primary))",
          "primary-foreground": "hsl(var(--sf-primary-foreground))",
          secondary: "hsl(var(--sf-secondary))",
          "secondary-foreground": "hsl(var(--sf-secondary-foreground))",
          accent: "hsl(var(--sf-accent))",
          "accent-foreground": "hsl(var(--sf-accent-foreground))",
          destructive: "hsl(var(--sf-destructive))",
          ring: "hsl(var(--sf-ring))",
        },
        nexoNavy: "#0f172a",
        canvasBg: "#f8fafc",
        accentFuchsia: "#d946ef",
        /* Semantic tokens (match :root in index.css) — enables bg-app-accent, border-app-accent/20, etc. */
        app: {
          accent: "var(--app-accent)",
          "accent-2": "var(--app-accent-2)",
          "accent-hover": "color-mix(in srgb, var(--app-accent) 88%, #000)",
          "input-border": "var(--app-input-border)",
          "input-bg": "var(--app-input-bg)",
        },
        /* Wedding Manager (riverside-wedding-manager parity) */
        navy: {
          50: "#f0f4f8",
          100: "#d9e2ec",
          700: "#243b53",
          800: "#102a43",
          900: "#0f172a",
        },
        gold: {
          100: "#f1f4e6",
          500: "#d69e2e",
          600: "#b7791f",
        },
      },
      fontFamily: {
        sans: ["Inter", "SF Pro Text", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      spacing: {
        "density-compact": "0.625rem",
        "density-standard": "1rem",
      },
      borderRadius: {
        "density-compact": "0.625rem",
        "density-standard": "0.875rem",
      },
      fontSize: {
        "density-compact": ["0.75rem", { lineHeight: "1rem" }],
        "density-standard": ["0.875rem", { lineHeight: "1.25rem" }],
      },
      transitionDuration: {
        fast: "120ms",
        normal: "180ms",
        slow: "280ms",
      },
      transitionTimingFunction: {
        standard: "cubic-bezier(0.22, 1, 0.36, 1)",
        material: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      borderRadius: {
        lg: "var(--sf-radius)",
        md: "calc(var(--sf-radius) - 2px)",
        sm: "calc(var(--sf-radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
