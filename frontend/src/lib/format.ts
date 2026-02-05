export function formatDuration(
  totalSeconds: number | null | undefined
): string {
  if (totalSeconds == null || isNaN(totalSeconds as number)) return "";
  const s = Math.max(0, Math.round(totalSeconds as number));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  if (h > 0) return `${h}h${mm}m${ss}s`;
  return `${mm}m${ss}s`;
}

export function formatDistance(meters: number | null | undefined): string {
  if (meters == null || isNaN(meters as number)) return "";
  const km = (meters as number) / 1000;
  return `${km.toFixed(2)}km`;
}

export function formatPace(secondsPerKm: number | null | undefined): string {
  if (secondsPerKm == null) return "";
  const s = Number(secondsPerKm);
  if (!Number.isFinite(s) || s <= 0) return "";
  const minutes = Math.floor(s / 60);
  const seconds = Math.round(s % 60);
  const ss = String(seconds).padStart(2, "0");
  return `${minutes}:${ss}/km`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const s = String(iso).trim();
  const hasTz = /[zZ]|[+-]\d{2}:\d{2}$/.test(s);
  let d: Date | null = null;
  if (hasTz) {
    const parsed = new Date(s);
    d = Number.isNaN(parsed.getTime()) ? null : parsed;
  } else {
    const m = s.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/
    );
    if (m) {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      const day = parseInt(m[3], 10);
      const hour = parseInt(m[4] ?? "0", 10);
      const minute = parseInt(m[5] ?? "0", 10);
      const second = parseInt(m[6] ?? "0", 10);
      d = new Date(year, month, day, hour, minute, second);
    }
  }
  if (!d) {
    const parsed = new Date(s);
    d = Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (!d) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const mon = months[d.getMonth()];
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const hh = String(hours).padStart(2, "0");
  return `${day} ${mon}, ${year} ${hh}:${minutes} ${ampm}`;
}
