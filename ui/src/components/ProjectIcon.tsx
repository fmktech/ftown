const paths = {
  project: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  bridge: "M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5z M12 16.5v3 M8.5 20h7",
  tickets: "M4 4.5h16v15H4z M9.5 5v14 M15 5v14",
  discussion: "M5.5 4.5h13A2.5 2.5 0 0 1 21 7v8a2.5 2.5 0 0 1-2.5 2.5h-8L5 21v-3.5A2.5 2.5 0 0 1 3 15V7a2.5 2.5 0 0 1 2.5-2.5z M7.5 9h9 M7.5 13h6",
  settings: "M4 7h16M9 4v6M4 17h16M15 14v6",
  back: "M19 12H5m6-6-6 6 6 6",
  plus: "M12 5v14M5 12h14",
  session: "M3.5 4.5h17v15h-17z M7 9l3 3-3 3m6 0h4",
  grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
  link: "M10 13.5a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5 M14 10.5a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1.5-1.5",
  person: "M15.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z M5 20v-1a7 7 0 0 1 14 0v1",
  chevron: "m9 5 7 7-7 7",
  edit: "m14.5 5.5 4 4 M4 20l4.5-1 12-12-3.5-3.5-12 12z",
  archive: "M3 4h18v5H3z M5 9v11h14V9 M9 13h6",
  refresh: "M20 4v5h-5 M4 20v-5h5 M5 9a7.5 7.5 0 0 1 12-4l3 4 M4 15l3 4a7.5 7.5 0 0 0 12-4",
  send: "m3 10 18-7-6.5 18-3.5-8z M11 13l10-10",
};

export function ProjectIcon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={name === "grip" ? 3 : 1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d={paths[name]} />
  </svg>;
}
