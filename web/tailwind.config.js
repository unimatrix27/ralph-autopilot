/**
 * Tailwind config for the control-plane SPA. Dark-first (the app boots with the
 * `dark` class on <html>; light is available by removing it). Colours are wired to
 * the CSS-variable design tokens in src/index.css — including the **status palette**
 * (`status-*`) mapped to the daemon's label state machine — so nothing is one-off
 * styled (ADR-0031).
 */
import tailwindcssAnimate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Semantic status palette — mapped to the label state machine (see
        // src/lib/status.ts). Each carries a matching foreground for text-on-fill.
        status: {
          eligible: "hsl(var(--status-eligible))",
          "eligible-foreground": "hsl(var(--status-eligible-foreground))",
          running: "hsl(var(--status-running))",
          "running-foreground": "hsl(var(--status-running-foreground))",
          waiting: "hsl(var(--status-waiting))",
          "waiting-foreground": "hsl(var(--status-waiting-foreground))",
          attention: "hsl(var(--status-attention))",
          "attention-foreground": "hsl(var(--status-attention-foreground))",
          danger: "hsl(var(--status-danger))",
          "danger-foreground": "hsl(var(--status-danger-foreground))",
          success: "hsl(var(--status-success))",
          "success-foreground": "hsl(var(--status-success-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
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
