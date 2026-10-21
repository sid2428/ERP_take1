/** Colours and font taken from the PICT Student Portal mockup. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        page: '#F3F5F8', navy: '#1F3A6E', 'navy-dark': '#16284D', ink: '#172033',
        muted: '#5B6578', line: '#DDE2EA', rule: '#E6E9F0', soft: '#F8F9FB',
        active: '#E9EEF8', label: '#7A8497', amber: '#B25E09', link: '#1F4FA3',
        ok: '#14674A', 'ok-bg': '#E3F4EC', 'warn-bg': '#FBEFD9', 'warn-ink': '#8F4A06',
        'err-bg': '#FBE4E4', 'err-ink': '#A32B2B',
      },
      fontFamily: { sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
  important: '#fee-root',
  corePlugins: { preflight: false },
};
