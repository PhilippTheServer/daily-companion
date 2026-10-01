import type { EventOut, Kind, Metric } from '../../core/api/types';
import { humanize } from '../forms/schema';
import { round } from '../number';
import { duration } from '../time';

/** What a timeline row says about an event. */
export interface Line {
  title: string;
  detail: string;
}

type Payload = Record<string, unknown>;

const KIND_LABELS: Record<Kind, string> = {
  intake: 'Meal',
  outtake: 'Bowel movement',
  symptom: 'Symptom',
  medication: 'Medication',
  supplement: 'Supplement',
  sleep: 'Sleep',
  activity: 'Activity',
  workout: 'Workout',
  measurement: 'Measurement',
  checkin: 'Check-in',
  note: 'Note',
};

const METRIC_LABELS: Record<Metric, string> = {
  weight_kg: 'Weight',
  waist_cm: 'Waist',
  body_fat_pct: 'Body fat',
  resting_hr_bpm: 'Resting heart rate',
  hrv_ms: 'HRV',
  spo2_pct: 'SpO₂',
  skin_temp_delta_c: 'Skin temperature change',
  blood_pressure_sys: 'Blood pressure (systolic)',
  blood_pressure_dia: 'Blood pressure (diastolic)',
};

const NOTE_LIMIT = 120;

const parts = (...values: unknown[]) => values.filter((value) => value || value === 0).join(' · ');

const truncate = (text: string) =>
  text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT)}…` : text;

function intake(payload: Payload): Line {
  const items = (payload['items'] as { name: string; grams: number }[] | undefined) ?? [];
  const nutrients = (payload['nutrients'] as Payload | undefined) ?? {};
  const slot = payload['slot'] ? humanize(String(payload['slot'])) : 'Meal';
  return {
    title: parts(slot, items.map((item) => item.name).join(', ')),
    detail: parts(
      `${round(nutrients['kcal'])} kcal`,
      `P ${round(nutrients['protein_g'])} g`,
      `C ${round(nutrients['carbs_g'])} g`,
      `F ${round(nutrients['fat_g'])} g`,
    ),
  };
}

/** The title and one-line detail of an event, per kind. */
export function describeEvent(event: EventOut): Line {
  const payload = event.payload as Payload;
  switch (event.kind) {
    case 'intake':
      return intake(payload);
    case 'outtake':
      return {
        title: KIND_LABELS.outtake,
        detail: parts(
          `Bristol ${payload['bristol']}`,
          payload['urgency'] ? 'urgent' : '',
          payload['pain'] ? `pain ${payload['pain']}/5` : '',
          ((payload['flags'] as string[] | undefined) ?? []).join(', '),
        ),
      };
    case 'symptom':
      return {
        title: humanize(String(payload['type'])),
        detail: parts(`severity ${payload['severity']}/5`, payload['body_area']),
      };
    case 'medication':
    case 'supplement':
      return {
        title: String(payload['name']),
        detail: parts(`${payload['dose']} ${payload['unit']}`, payload['reason']),
      };
    case 'sleep':
      return {
        title: KIND_LABELS.sleep,
        detail: parts(
          event.ends_at ? duration(event.occurred_at, event.ends_at) : '',
          payload['quality'] ? `quality ${payload['quality']}/5` : '',
        ),
      };
    case 'activity':
      return {
        title: KIND_LABELS.activity,
        detail: parts(
          payload['steps'] != null ? `${payload['steps']} steps` : '',
          payload['active_minutes'] != null ? `${payload['active_minutes']} active min` : '',
          payload['distance_km'] != null ? `${payload['distance_km']} km` : '',
        ),
      };
    case 'workout':
      return {
        title: String(payload['title']),
        detail: parts(
          humanize(String(payload['category'])),
          event.ends_at ? duration(event.occurred_at, event.ends_at) : '',
          payload['set_count'] != null ? `${payload['set_count']} sets` : '',
        ),
      };
    case 'measurement':
      return {
        title: METRIC_LABELS[payload['metric'] as Metric] ?? humanize(String(payload['metric'])),
        detail: parts(`${payload['value']} ${payload['unit'] ?? ''}`.trim()),
      };
    case 'checkin':
      return {
        title: KIND_LABELS.checkin,
        detail: parts(
          `overall ${payload['overall']}/5`,
          payload['energy'] ? `energy ${payload['energy']}/5` : '',
          payload['mood'] ? `mood ${payload['mood']}/5` : '',
          payload['stress'] ? `stress ${payload['stress']}/5` : '',
        ),
      };
    case 'note':
      return { title: KIND_LABELS.note, detail: truncate(String(payload['text'])) };
  }
}

/** The name of a kind, for pickers and headings. */
export function kindLabel(kind: Kind): string {
  return KIND_LABELS[kind];
}

/** Every kind, in the order of the spec. */
export const KINDS = Object.keys(KIND_LABELS) as Kind[];
