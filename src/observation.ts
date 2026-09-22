import { createHash } from "node:crypto";
import { isRiskyActionLabel } from "./policy.js";
import type { BrowserElement, Candidate, Observation, Operation } from "./types.js";

const INTERACTIVE = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "select",
  "option",
  "spinbutton",
]);
const SECRET = /password|passcode|secret|token|api.?key|credential|cvv|cvc|card number/i;

function clean(value: unknown, max = 180): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function redactSnapshotText(value: string): string {
  return value
    .split("\n")
    .map((line) =>
      SECRET.test(line)
        ? line.replace(/(value\s*=\s*)"[^"]*"/gi, '$1"[redacted]"').replace(/(value\s*=\s*)'[^']*'/gi, "$1'[redacted]'")
        : line,
    )
    .join("\n");
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

export function isSecretField(element: Pick<BrowserElement, "role" | "name">): boolean {
  return element.role.toLowerCase() === "password" || SECRET.test(element.name);
}

export function normalizeSnapshot(raw: unknown, maxText = 2400): Observation {
  const outer = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const data = outer.data && typeof outer.data === "object" ? (outer.data as Record<string, unknown>) : outer;
  const refs = data.refs && typeof data.refs === "object" ? (data.refs as Record<string, unknown>) : {};
  const elements: BrowserElement[] = [];
  for (const [id, value] of Object.entries(refs)) {
    if (!value || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;
    const role = clean(node.role ?? node.type).toLowerCase();
    if (!INTERACTIVE.has(role)) continue;
    const ref = id.startsWith("@") ? id : `@${id}`;
    const name = clean(node.name ?? node.label ?? node.placeholder ?? ref);
    const element: BrowserElement = { ref, role, name };
    if (typeof node.disabled === "boolean") element.disabled = node.disabled;
    if (typeof node.checked === "boolean") element.checked = node.checked;
    if (typeof node.selected === "boolean") element.selected = node.selected;
    if (typeof node.value === "string") element.value = isSecretField(element) ? "[redacted]" : clean(node.value);
    if (Array.isArray(node.options))
      element.options = node.options.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const option = item as Record<string, unknown>;
        const label = clean(option.label ?? option.name ?? option.value);
        const optionValue = clean(option.value ?? option.label ?? option.name);
        return label || optionValue
          ? [
              {
                label: label || optionValue,
                value: optionValue || label,
                disabled: option.disabled === true,
                selected: option.selected === true,
              },
            ]
          : [];
      });
    elements.push(element);
  }
  const url = clean(data.url ?? data.origin, 1000);
  const title = clean(data.title, 300);
  const text = redactSnapshotText(clean(data.snapshot ?? data.text ?? "", maxText));
  const base = { url, title, text, elements };
  return { ...base, fingerprint: hash(base) };
}

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1),
  );
}

function usefulness(goal: string, element: BrowserElement, index: number): number {
  const goalWords = words(goal);
  const elementWords = words(`${element.role} ${element.name}`);
  let score = Math.max(0, 20 - index / 10);
  const normalizedGoal = clean(goal).toLowerCase();
  const normalizedName = clean(element.name).toLowerCase();
  if (normalizedName && normalizedGoal.includes(normalizedName)) score += 60;
  for (const word of goalWords) if (elementWords.has(word)) score += 20;
  if (["button", "textbox", "searchbox", "combobox"].includes(element.role)) score += 8;
  if (element.disabled) score -= 100;
  return score;
}

function semanticValueKey(element: BrowserElement, values: Record<string, string>): string | undefined {
  const normalized = element.name.toLowerCase().replace(/\s+/g, " ").trim();
  const keys = [element.ref, `${element.role}:${normalized}`, element.name, normalized];
  return keys.find((key) => Object.hasOwn(values, key));
}

export interface CandidateSpace {
  all: Candidate[];
  byOperation: Map<Operation, Candidate[]>;
}

export function buildCandidates(
  observation: Observation,
  goal: string,
  values: Record<string, string> = {},
  max = 32,
): CandidateSpace {
  const candidates: Candidate[] = [];
  const ranked = observation.elements
    .map((element, index) => ({ element, index, score: usefulness(goal, element, index) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const add = (candidate: Omit<Candidate, "id">) => candidates.push({ ...candidate, id: `c${candidates.length + 1}` });
  for (const { element } of ranked) {
    if (element.disabled || candidates.length >= max) continue;
    const role = element.role;
    const label = `${role} “${element.name}”`;
    if (["textbox", "searchbox", "spinbutton"].includes(role) || (role === "combobox" && !element.options?.length)) {
      const valueKey = semanticValueKey(element, values);
      add({
        operation: "TYPE",
        ref: element.ref,
        label: `Type into ${label}`,
        valueKey,
        value: valueKey ? values[valueKey] : undefined,
        secret: isSecretField(element),
      });
      if (role === "combobox" && candidates.length < max)
        add({ operation: "CLICK", ref: element.ref, label: `Expand ${label}` });
    } else if (["combobox", "listbox", "select"].includes(role) && element.options?.length) {
      for (const option of element.options.filter((item) => !item.disabled).slice(0, 12)) {
        add({
          operation: "SELECT",
          ref: element.ref,
          option: option.value,
          label: `Select “${option.label}” in ${label}`,
        });
      }
    } else if (["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"].includes(role)) {
      add({ operation: "CLICK", ref: element.ref, label: `Click ${label}`, risky: isRiskyActionLabel(element.name) });
    }
  }
  for (const key of ["Enter", "Escape", "Tab"] as const) add({ operation: "PRESS", key, label: `Press ${key}` });
  add({ operation: "SCROLL", direction: "down", label: "Scroll down" });
  add({ operation: "SCROLL", direction: "up", label: "Scroll up" });
  add({ operation: "BACK", label: "Go back" });
  add({ operation: "WAIT", label: "Wait briefly for the page to update" });
  add({ operation: "DONE", label: "Claim that the bounded goal is complete" });
  add({ operation: "BLOCKED", label: "Stop because no safe supported action can progress" });

  const byOperation = new Map<Operation, Candidate[]>();
  for (const candidate of candidates) {
    const list = byOperation.get(candidate.operation) ?? [];
    list.push(candidate);
    byOperation.set(candidate.operation, list);
  }
  return { all: candidates, byOperation };
}

export function compactObservation(observation: Observation) {
  return {
    url: observation.url,
    title: observation.title,
    text: observation.text.slice(0, 900),
    elements: observation.elements.slice(0, 12).map(({ ref, role, name }) => ({ ref, role, name })),
  };
}
