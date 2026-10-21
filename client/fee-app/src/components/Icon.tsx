const PATHS: Record<string, string> = {
  home: 'M3 11l9-8 9 8v10H15v-6H9v6H3z',
  book: 'M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z',
  check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12l3 3 5-6',
  list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  calendar: 'M4 6h16v14H4z M4 10h16 M9 3v4 M15 3v4',
  doc: 'M7 3h8l4 4v14H7z M15 3v4h4',
  warn: 'M12 4l9 16H3z M12 10v4 M12 17h.01',
  wallet: 'M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4z M4 7l12-3v3 M16 14h2',
  user: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c0-4 4-6 8-6s8 2 8 6',
  award: 'M12 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M8.5 13.5L7 21l5-3 5 3-1.5-7.5',
  chat: 'M4 5h16v11H9l-5 4z',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7 M10 20a2 2 0 0 0 4 0',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4',
  receipt: 'M7 3h10v18l-2-1.5-3 1.5-3-1.5L7 21z M10 8h4 M10 12h4',
  tick: 'M5 12l5 5 9-10',
};

export default function Icon({ name, size = 16, className = '' }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d={PATHS[name]} />
    </svg>
  );
}
