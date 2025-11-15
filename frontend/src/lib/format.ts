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
  const s = String(iso);
  // Prefer rendering the literal local time encoded in the string without timezone conversion.
  // Extract YYYY-MM-DDTHH:MM (ignore any timezone suffix like Z or +hh:mm)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  if (m) {
    const [, y, mo, d, h, mi] = m;
    const year = y;
    const mon = months[Math.max(0, Math.min(11, parseInt(mo, 10) - 1))];
    let hours = parseInt(h, 10);
    const minutes = mi;
    const ampm = hours >= 12 ? "pm" : "am";
    hours = hours % 12; if (hours === 0) hours = 12;
    const hh = String(hours).padStart(2, "0");
    const day = d;
    return `${day} ${mon}, ${year} ${hh}:${minutes} ${ampm}`;
  }
  // Fallback to Date parsing if the string is non-standard
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
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
