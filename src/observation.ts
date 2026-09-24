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

interface TreeAttributes {
  parent?: string;
  name?: string;
  disabled?: boolean;
  selected?: boolean;
}

// agent-browser returns a flat ref map plus an indented accessibility tree.
// The tree is the only place that carries nesting and state markers such as
// `disabled`/`selected`, so parse it to recover parent/child relationships.
function parseSnapshotTree(snapshot: string): Map<string, TreeAttributes> {
  const attributes = new Map<string, TreeAttributes>();
  const stack: Array<{ indent: number; ref?: string }> = [];
  for (const line of snapshot.split("\n")) {
    const lineMatch = /^(\s*)- (.*)$/.exec(line);
    if (!lineMatch) continue;
    const indent = lineMatch[1].length;
    const body = lineMatch[2];
    const bracket = /\[([^\]]*\bref=[^,\]]+[^\]]*)\]/.exec(body);
    const tokens = bracket ? bracket[1].split(",").map((token) => token.trim()) : [];
    const ref = tokens.find((token) => token.startsWith("ref="))?.slice(4);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (ref) {
      const name = /^(?:- )?\S*(?::\s*)? "((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
      attributes.set(ref, {
        parent: stack.findLast((entry) => entry.ref)?.ref,
        name: name ? name.replace(/\\"/g, '"') : undefined,
        disabled: tokens.includes("disabled"),
        selected: tokens.includes("selected"),
      });
    }
    stack.push({ indent, ref });
  }
  return attributes;
}

// Options of a native <select> are exposed as children of the combobox. They
// cannot be clicked (no box model) and are only reachable through the parent
// select, so fold them into the parent's option list.
function foldSelectOptions(elements: BrowserElement[], tree: Map<string, TreeAttributes>): void {
  const byRef = new Map(elements.map((element) => [element.ref.slice(1), element]));
  const folded = new Set<string>();
  for (const element of elements) {
    const attributes = tree.get(element.ref.slice(1));
    if (!attributes) continue;
    if (attributes.disabled) element.disabled = true;
    if (attributes.selected) element.selected = true;
    if (element.role !== "option" || !attributes.parent) continue;
    const parent = byRef.get(attributes.parent);
    if (!parent || !["combobox", "select"].includes(parent.role)) continue;
    const label = clean(attributes.name ?? element.name);
    if (!label || label.startsWith("@")) continue;
    parent.options ??= [];
    if (parent.options.some((option) => option.label === label)) continue;
    parent.options.push({
      label,
      value: label,
      selected: element.selected === true,
      disabled: element.disabled === true,
    });
    folded.add(element.ref);
  }
  if (folded.size) elements.splice(0, elements.length, ...elements.filter((element) => !folded.has(element.ref)));
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
    if (typeof node.filled === "boolean") element.filled = node.filled;
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
  const treeText = typeof data.snapshot === "string" ? data.snapshot : "";
  const renderedText = typeof data.text === "string" ? data.text : "";
  const tree = parseSnapshotTree(treeText);
  if (tree.size) foldSelectOptions(elements, tree);
  // The accessibility tree keeps the structure Jev reasons over; the rendered
  // page text is what text verifiers can honestly match against.
  const base = {
    url,
    title,
    text: redactSnapshotText(clean(treeText || renderedText, maxText)),
    pageText: redactSnapshotText(clean(renderedText, maxText)),
    elements,
  };
  return { ...base, fingerprint: hash({ url, title, text: base.text, elements }) };
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

const TYPABLE = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function exactValueKey(element: BrowserElement, values: Record<string, string>): string | undefined {
  const normalized = normalizedName(element.name);
  const keys = [element.ref, `${element.role}:${normalized}`, element.name, normalized];
  return keys.find((key) => Object.hasOwn(values, key));
}

function looseValueKeys(element: BrowserElement, values: Record<string, string>): string[] {
  const name = normalizedName(element.name);
  if (!name) return [];
  return Object.keys(values).filter((key) => {
    const candidate = normalizedName(key);
    return candidate.length > 0 && (name.includes(candidate) || candidate.includes(name));
  });
}

// Callers name a value after the field as they see it ("Search") while the page
// may label it more specifically ("Search Wikipedia"). Exact keys win; a partial
// name binds only when exactly one typable field matches, so ambiguous keys keep
// returning input_required instead of filling an arbitrary field.
function semanticValueKey(
  element: BrowserElement,
  values: Record<string, string>,
  typable: BrowserElement[],
): string | undefined {
  const exact = exactValueKey(element, values);
  if (exact) return exact;
  const loose = looseValueKeys(element, values);
  if (loose.length !== 1) return undefined;
  const [key] = loose;
  const matches = typable.filter(
    (candidate) => exactValueKey(candidate, values) === key || looseValueKeys(candidate, values).includes(key),
  );
  return matches.length === 1 ? key : undefined;
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
  const typable = observation.elements.filter((element) => TYPABLE.has(element.role) && !element.disabled);
  const ranked = observation.elements
    .map((element, index) => ({ element, index, score: usefulness(goal, element, index) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const add = (candidate: Omit<Candidate, "id">) => candidates.push({ ...candidate, id: `c${candidates.length + 1}` });
  // Fields and option lists are few and are usually the point of the goal. They
  // keep reserved room in the budget, because on a page with many links the
  // ranked click candidates would otherwise fill it and push the field the
  // caller wants to fill out of the offered space.
  const fieldBudget = Math.min(12, max);
  let fields = 0;
  const addField = (candidate: Omit<Candidate, "id">) => {
    if (fields >= fieldBudget) return;
    fields += 1;
    add(candidate);
  };
  const addAction = (candidate: Omit<Candidate, "id">) => {
    if (candidates.length < max) add(candidate);
  };
  for (const { element } of ranked) {
    if (element.disabled) continue;
    const role = element.role;
    const label = `${role} “${element.name}”`;
    if (["textbox", "searchbox", "spinbutton"].includes(role) || (role === "combobox" && !element.options?.length)) {
      const valueKey = semanticValueKey(element, values, typable);
      const value = valueKey ? values[valueKey] : undefined;
      // A field that already holds the caller's value makes retyping a no-op, so
      // keep it out of the offered space instead of tempting a repeated action.
      if (value !== undefined && element.value === value) continue;
      // A filled secret field cannot be compared against its value, so treat any
      // existing content as already entered rather than typing the secret again.
      if (isSecretField(element) && element.filled) continue;
      addField({
        operation: "TYPE",
        ref: element.ref,
        label: `Type into ${label}`,
        valueKey,
        value,
        secret: isSecretField(element),
      });
      if (role === "combobox") addField({ operation: "CLICK", ref: element.ref, label: `Expand ${label}` });
    } else if (["combobox", "listbox", "select"].includes(role) && element.options?.length) {
      for (const option of element.options.filter((item) => !item.disabled).slice(0, 12)) {
        addField({
          operation: "SELECT",
          ref: element.ref,
          option: option.value,
          label: `Select “${option.label}” in ${label}`,
        });
      }
    } else if (["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"].includes(role)) {
      addAction({
        operation: "CLICK",
        ref: element.ref,
        label: `Click ${label}`,
        risky: isRiskyActionLabel(element.name),
      });
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
