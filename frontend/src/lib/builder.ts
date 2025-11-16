import type { Condition, Effect } from "./api";

export type ConditionKind =
  | "sport_type"
  | "distance"
  | "moving_time"
  | "moving_pace"
  | "total_elevation_gain"
  | "title"
  | "day_of_week"
  | "start_near"
  | "end_near";

export type ConditionOp =
  | "equals"
  | "contains"
  | "in"
  | "not_in"
  | "gt"
  | "ge"
  | "lt"
  | "le"
  | "eq"
  | "within";

export const CONDITION_SPECS: Record<
  ConditionKind,
  { label: string; ops: ConditionOp[]; placeholder?: string }
> = {
  sport_type: { label: "Sport Type", ops: ["equals"], placeholder: "e.g. Run" },
  distance: {
    label: "Distance (m)",
    ops: ["gt", "ge", "lt", "le", "eq"],
    placeholder: "e.g. 5000",
  },
  moving_time: {
    label: "Moving time (s)",
    ops: ["gt", "ge", "lt", "le", "eq"],
    placeholder: "e.g. 30:00 or 1800",
  },
  moving_pace: {
    label: "Moving pace (s/km)",
    ops: ["gt", "ge", "lt", "le", "eq"],
    placeholder: "e.g. 5:00 or 300",
  },
  total_elevation_gain: {
    label: "Elevation gain (m)",
    ops: ["gt", "ge", "lt", "le", "eq"],
    placeholder: "e.g. 300",
  },
  title: { label: "Title", ops: ["contains"], placeholder: "e.g. Commute" },
  day_of_week: {
    label: "Day of week",
    ops: ["in", "not_in"],
    placeholder: "Mon,Wed,Fri",
  },
  start_near: {
    label: "Start within radius of (lat/lon)",
    ops: ["within"],
    placeholder: "lat,lon,radius(m)",
  },
  end_near: {
    label: "End within radius of (lat/lon)",
    ops: ["within"],
    placeholder: "lat,lon,radius(m)",
  },
};

export type EffectKind =
  | "set_title_suffix"
  | "set_title_prefix"
  | "set_commute"
  | "set_sport_type"
  | "set_long_run_tag"
  | "set_shoes_by_id"
  | "set_title_template";

export function conditionFrom(
  kind: ConditionKind,
  op: ConditionOp,
  raw: string | string[]
): Condition {
  if (kind === "sport_type") {
    return { type: "sport_type", op, value: String(raw).trim() };
  }
  if (kind === "title") {
    return { type: "title", op, value: String(raw).trim() };
  }
  if (kind === "day_of_week") {
    const arr = Array.isArray(raw)
      ? raw
      : String(raw)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    return { type: "day_of_week", op, value: arr };
  }
  if (kind === "moving_time" || kind === "moving_pace") {
    const rawStr = Array.isArray(raw) ? raw[0] ?? "" : String(raw);
    const secs = parseDurationSeconds(rawStr);
    const value =
      Number.isFinite(secs) && secs !== null ? secs : Number(rawStr || 0);
    return { type: kind, op, value };
  }
  if (kind === "start_near" || kind === "end_near") {
    let lat = 0;
    let lon = 0;
    let radius = 100;
    if (Array.isArray(raw)) {
      lat = Number(raw[0] ?? 0);
      lon = Number(raw[1] ?? 0);
      radius = Number(raw[2] ?? 100);
    } else {
      const parts = String(raw)
        .split(",")
        .map((s) => s.trim());
      lat = Number(parts[0] ?? 0);
      lon = Number(parts[1] ?? 0);
      radius = Number(parts[2] ?? 100);
    }
    return { type: kind, op, value: { lat, lon, radius_m: radius } };
  }
  const rawStr = Array.isArray(raw) ? raw[0] ?? 0 : raw;
  const num = Number(rawStr);
  return { type: kind, op, value: num };
}

/**
 * Back-compat helper for any existing calls.
 * Maps legacy condition kinds to their modern equivalents with default operators.
 */
export function conditionFromSelection(
  kind: ConditionKind | string,
  raw: string
): Condition {
  switch (kind) {
    case "sport_type":
      return conditionFrom("sport_type", "equals", raw);
    case "distance":
    case "distance_greater_than":
      return conditionFrom("distance", "gt", raw);
    case "moving_time":
    case "moving_time_greater_than":
      return conditionFrom("moving_time", "gt", raw);
    case "total_elevation_gain":
    case "elevation_gain_greater_than":
      return conditionFrom("total_elevation_gain", "gt", raw);
    case "title":
    case "title_contains":
      return conditionFrom("title", "contains", raw);
    case "day_of_week":
      return conditionFrom("day_of_week", "in", raw);
    default:
      throw new Error(`Unknown condition kind: ${kind}`);
  }
}

export function effectFromSelection(kind: EffectKind, raw: string): Effect {
  switch (kind) {
    case "set_title_suffix":
      return { type: "set_title_suffix", params: { suffix: raw || "" } };
    case "set_title_prefix":
      return { type: "set_title_prefix", params: { prefix: raw || "" } };
    case "set_commute":
      return { type: "set_commute", params: { commute: true } };
    case "set_sport_type":
      return { type: "set_sport_type", params: { sport_type: raw || "Run" } };
    case "set_long_run_tag":
      return { type: "set_long_run_tag" };
    case "set_shoes_by_id":
      return { type: "set_shoes_by_id", params: { gear_id: raw } };
    case "set_title_template":
      return {
        type: "set_title_template",
        params: { template: raw || "Commute #{count:commute}" },
      };
    default:
      throw new Error(`Unknown effect kind: ${kind}`);
  }
}

// -------------------- Helpers --------------------

/**
 * Parse durations like "mm:ss", "h:mm:ss", optionally like "5m30s" or with "/km" suffix, to total seconds.
 * Returns null if parsing fails.
 */
export function parseDurationSeconds(text: string): number | null {
  if (!text || typeof text !== "string") {
    return null;
  }

  let s = text.trim().toLowerCase();
  s = s
    .replace(/\/km$/, "")
    .replace(/perkm/, "")
    .replace(/per km/, "")
    .trim();

  // HH:MM:SS format
  if (/^\d{1,2}:\d{1,2}:\d{1,2}$/.test(s)) {
    const parts = s.split(":");
    const h = parseInt(parts[0]!, 10);
    const m = parseInt(parts[1]!, 10);
    const sec = parseInt(parts[2]!, 10);
    if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(sec)) {
      return h * 3600 + m * 60 + sec;
    }
  }

  // MM:SS format
  if (/^\d{1,2}:\d{1,2}$/.test(s)) {
    const parts = s.split(":");
    const m = parseInt(parts[0]!, 10);
    const sec = parseInt(parts[1]!, 10);
    if (Number.isFinite(m) && Number.isFinite(sec)) {
      return m * 60 + sec;
    }
  }

  // Format like "5m30s", "45s", "1h2m"
  if (/\d+[hms]/.test(s)) {
    let total = 0;
    const re = /(\d+)([hms])/g;
    let match: RegExpExecArray | null;

    while ((match = re.exec(s))) {
      const val = parseInt(match[1]!, 10);
      const unit = match[2];

      if (!Number.isFinite(val)) {
        continue;
      }

      if (unit === "h") {
        total += val * 3600;
      } else if (unit === "m") {
        total += val * 60;
      } else if (unit === "s") {
        total += val;
      }
    }

    if (total > 0) {
      return total;
    }
  }

  // Try direct numeric parsing
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
