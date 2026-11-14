/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Signal & Graphite (katagami.ai/palettes/signal-graphite): graphite ground,
      // hairline keylines, one signal-yellow accent, quiet semantics.
      colors: {
        base: '#101214',
        panel: '#16181A',
        raised: '#1E2124',
        overlay: '#272B2E',
        line: {
          DEFAULT: '#30353A',
          strong: '#454B50',
        },
        fg: {
          DEFAULT: '#EDEBE6',
          muted: '#9CA1A4',
          faint: '#6E7478',
        },
        accent: {
          DEFAULT: '#E8C400',
          hover: '#F2DA4E',
          ink: '#16181A',
        },
        ok: '#6FA56B',
        warn: '#D9A441',
        err: '#D5604A',
        info: '#6E94B0',
      },
      fontSize: {
        '2xs': ['11.5px', '15px'],
        xs: ['13px', '18px'],
      },
    },
  },
  plugins: [],
}
