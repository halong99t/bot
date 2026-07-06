/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0e11",
        panel: "#161a1e",
        panel2: "#1e2329",
        border: "#2b3139",
        up: "#0ecb81",
        down: "#f6465d",
        accent: "#f0b90b",
      },
    },
  },
  plugins: [],
};
