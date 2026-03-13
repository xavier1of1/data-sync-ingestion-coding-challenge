import type { NormalizedEvent } from "./types";

const TIMESTAMP_KEYS = [
  "occurredAt",
  "occurred_at",
  "timestamp",
  "time",
  "createdAt",
  "created_at",
] as const;

const EVENT_TYPE_KEYS = ["event_type", "eventType", "type", "name"] as const;

const EVENT_ID_KEYS = ["id", "eventId", "event_id", "uuid"] as const;

export function normalizeEvent(raw: unknown): NormalizedEvent | null {
  const payload = toPayloadObject(raw);
  const eventId = pickEventId(payload);

  if (!eventId) {
    return null;
  }

  return {
    id: eventId,
    eventType: pickEventType(payload),
    occurredAt: pickOccurredAt(payload),
    rawPayload: payload,
    ingestedAt: new Date(),
  };
}

function toPayloadObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }

  return {
    value: raw,
  };
}

function pickEventId(payload: Record<string, unknown>): string | null {
  for (const key of EVENT_ID_KEYS) {
    const value = payload[key];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function pickEventType(payload: Record<string, unknown>): string | null {
  for (const key of EVENT_TYPE_KEYS) {
    const value = payload[key];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function pickOccurredAt(payload: Record<string, unknown>): Date | null {
  for (const key of TIMESTAMP_KEYS) {
    const timestamp = parseTimestamp(payload[key]);

    if (timestamp) {
      return timestamp;
    }
  }

  return null;
}

function parseTimestamp(value: unknown): Date | null {
  if (value === null || typeof value === "undefined") {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return fromNumericTimestamp(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return null;
    }

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const asNumber = Number(trimmed);

      if (Number.isFinite(asNumber)) {
        return fromNumericTimestamp(asNumber);
      }
    }

    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function fromNumericTimestamp(value: number): Date | null {
  const asMilliseconds = Math.abs(value) < 1e11 ? value * 1000 : value;
  const parsed = new Date(asMilliseconds);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
