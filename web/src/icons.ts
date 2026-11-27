import type { CanonicalPlatform } from './utils';

function svg(b: string, cls = 'ico'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${b}</svg>`;
}

export const icons = {
  brand: () => svg('<path d="M12 2L4 6v6c0 5.2 3.4 9.6 8 10 4.6-.4 8-4.8 8-10V6zM8.5 11.5l2.5 2-2.5 2M12.5 15.5h3"/>', 'ico ico-brand'),
  overview: () => svg('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>'),
  devices: () => svg('<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01M10 7h8M10 17h8"/>'),
  console: () => svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 10l3 2.5L6 15M11 15h6"/>'),
  groups: () => svg('<path d="M12 2L2 7l10 5 10-5zM2 12l10 5 10-5M2 17l10 5 10-5"/>'),
  commands: () => svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  logs: () => svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"/>'),
  settings: () => svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  cog: () => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  sun: () => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M5 5l1.4 1.4M17.6 17.6L19 19M2 12h2M20 12h2M5 19l1.4-1.4M17.6 6.4L19 5"/>'),
  moon: () => svg('<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>'),
  monitor: () => svg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  menu: () => svg('<path d="M3 6h18M3 12h18M3 18h18"/>'),
  plus: () => svg('<path d="M12 5v14M5 12h14"/>'),
  trash: () => svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  edit: () => svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>'),
  copy: () => svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  download: () => svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  refresh: () => svg('<path d="M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>'),
  play: () => svg('<polygon points="5 3 19 12 5 21 5 3"/>'),
  pause: () => svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'),
  stop: () => svg('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  key: () => svg('<path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>'),
  logout: () => svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  search: () => svg('<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>'),
  back: () => svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  eye: () => svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  chevronDown: () => svg('<path d="M6 9l6 6 6-6"/>'),
  more: () => svg('<circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/>'),
  activity: () => svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
  cpu: () => svg('<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>'),
  platform(key: CanonicalPlatform): string {
    switch (key) {
      case 'linux':
        return svg('<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 9h8M8 13h8M8 17h4"/>');
      case 'openwrt':
        return svg('<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M6 13V8M18 13V8M9 6a4 4 0 0 1 6 0M7 16.5h.01M11 16.5h6"/>');
      case 'macos':
        return svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20M9 16l-1 4M15 16l1 4"/>');
      case 'windows':
        return svg('<path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z"/>');
      case 'android':
        return svg('<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M10 18h4M9 7h6"/>');
      case 'unix':
        return svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>');
      default:
        return svg('<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="12" cy="12" r="3"/>');
    }
  },
};
