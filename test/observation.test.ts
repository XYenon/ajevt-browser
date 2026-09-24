import assert from "node:assert/strict";
import test from "node:test";
import { buildCandidates, normalizeSnapshot } from "../src/observation.js";
import { observation } from "./helpers.js";

const WEB_FORM_TREE = [
  '- heading "Web form" [level=1, ref=e1]',
  '- textbox "Text input" [ref=e3]',
  '- textbox "Disabled input" [disabled, ref=e6]',
  '- combobox "Dropdown (select)" [expanded=false, ref=e9]: One',
  '  - option "Open this select menu" [ref=e18]',
  '  - option "One" [selected, ref=e19]',
  '  - option "Two" [ref=e20]',
  '- combobox "Dropdown (datalist)" [ref=e10]',
  "- listbox [ref=e30]",
  '  - option "Suggestion" [ref=e31]',
  '- button "Submit" [ref=e2]',
].join("\n");

function webForm() {
  return normalizeSnapshot({
    data: {
      url: "https://example.test/form",
      title: "Web form",
      refs: {
        e1: { role: "heading", name: "Web form" },
        e3: { role: "textbox", name: "Text input" },
        e6: { role: "textbox", name: "Disabled input" },
        e9: { role: "combobox", name: "Dropdown (select)" },
        e10: { role: "combobox", name: "Dropdown (datalist)" },
        e2: { role: "button", name: "Submit" },
        e18: { role: "option", name: "Open this select menu" },
        e19: { role: "option", name: "One" },
        e20: { role: "option", name: "Two" },
        e30: { role: "listbox", name: "" },
        e31: { role: "option", name: "Suggestion" },
      },
      snapshot: WEB_FORM_TREE,
    },
  });
}

test("native select options fold into their combobox and leave the element list", () => {
  const page = webForm();
  const select = page.elements.find((element) => element.ref === "@e9")!;
  assert.deepEqual(
    select.options?.map((option) => `${option.label}:${option.selected ? "selected" : "no"}`),
    ["Open this select menu:no", "One:selected", "Two:no"],
  );
  assert.equal(
    page.elements.some((element) => ["@e18", "@e19", "@e20"].includes(element.ref)),
    false,
  );
});

test("listbox options stay clickable elements", () => {
  const page = webForm();
  const option = page.elements.find((element) => element.ref === "@e31")!;
  assert.equal(option.role, "option");
  const space = buildCandidates(page, "pick a suggestion");
  assert.ok(space.byOperation.get("CLICK")?.some((candidate) => candidate.ref === "@e31"));
});

test("select options become SELECT candidates and not TYPE candidates", () => {
  const page = webForm();
  const space = buildCandidates(page, "select the dropdown option Two");
  assert.deepEqual(
    space.byOperation.get("SELECT")?.map((candidate) => candidate.option),
    ["Open this select menu", "One", "Two"],
  );
  assert.equal(
    space.byOperation.get("TYPE")?.some((candidate) => candidate.ref === "@e9"),
    false,
  );
});

test("disabled elements parsed from the tree are not offered", () => {
  const page = webForm();
  assert.equal(page.elements.find((element) => element.ref === "@e6")?.disabled, true);
  const space = buildCandidates(page, "type into disabled input");
  assert.equal(
    space.byOperation.get("TYPE")?.some((candidate) => candidate.ref === "@e6"),
    false,
  );
});

test("rendered page text is kept beside the accessibility text", () => {
  const page = normalizeSnapshot({
    data: {
      url: "https://example.test/done",
      title: "Done",
      text: "# Form submitted\n\nReceived!",
      refs: { e1: { role: "combobox", name: "Dropdown (select)" }, e2: { role: "option", name: "One" } },
      snapshot: '- combobox "Dropdown (select)" [ref=e1]\n  - option "One" [ref=e2]',
    },
  });
  assert.equal(page.text, '- combobox "Dropdown (select)" [ref=e1] - option "One" [ref=e2]');
  assert.equal(page.pageText, "# Form submitted Received!");
  assert.deepEqual(
    page.elements.find((element) => element.ref === "@e1")?.options?.map((option) => option.label),
    ["One"],
  );
});

test("a filled secret field is not offered for typing again", () => {
  const page = normalizeSnapshot({
    data: {
      url: "https://example.test/login",
      title: "Sign in",
      refs: {
        e1: { role: "textbox", name: "Username", value: "ada" },
        e2: { role: "textbox", name: "Password", value: "[redacted]", filled: true },
      },
    },
  });
  const space = buildCandidates(page, "sign in", { Username: "ada", Password: "hunter2" });
  assert.deepEqual(space.byOperation.get("TYPE") ?? [], []);
});

test("a filled non-secret field can still be overwritten", () => {
  const page = normalizeSnapshot({
    data: {
      url: "https://example.test/search",
      title: "Search",
      refs: { e1: { role: "searchbox", name: "Search", value: "old query", filled: true } },
    },
  });
  const space = buildCandidates(page, "search again", { Search: "new query" });
  const candidate = space.byOperation.get("TYPE")?.find((item) => item.ref === "@e1");
  assert.equal(candidate?.value, "new query");
});

test("a field keeps its candidate slot on a page full of links", () => {
  const elements = [
    { ref: "@e1", role: "searchbox", name: "Search Wikipedia" },
    ...Array.from({ length: 40 }, (_, index) => ({
      ref: `@l${index}`,
      role: "link",
      name: `Search result ${index}`,
    })),
  ];
  const page = observation({ elements });
  const space = buildCandidates(page, "search for browser automation", { Search: "Browser automation" });
  const candidate = space.byOperation.get("TYPE")?.find((item) => item.ref === "@e1");
  assert.equal(candidate?.valueKey, "Search");
  assert.equal(candidate?.value, "Browser automation");
});

test("a value key binds to a partially matching field name", () => {
  const page = normalizeSnapshot({
    data: {
      url: "https://example.test",
      title: "Search",
      refs: {
        e1: { role: "searchbox", name: "Search Wikipedia" },
        e2: { role: "radio", name: "Search" },
      },
    },
  });
  const space = buildCandidates(page, "search for browser automation", { Search: "Browser automation" });
  const candidate = space.byOperation.get("TYPE")?.find((item) => item.ref === "@e1");
  assert.equal(candidate?.valueKey, "Search");
  assert.equal(candidate?.value, "Browser automation");
});

test("an ambiguous value key stays unbound", () => {
  const page = normalizeSnapshot({
    data: {
      url: "https://example.test",
      title: "Sign in",
      refs: {
        e1: { role: "textbox", name: "First name" },
        e2: { role: "textbox", name: "Last name" },
      },
    },
  });
  const space = buildCandidates(page, "enter the name", { Name: "Ada" });
  assert.equal(
    space.byOperation.get("TYPE")?.every((candidate) => candidate.value === undefined),
    true,
  );
});

test("an exact value key still wins over a partial one", () => {
  const page = normalizeSnapshot({
    data: {
      url: "https://example.test",
      title: "Sign in",
      refs: {
        e1: { role: "textbox", name: "Search" },
        e2: { role: "textbox", name: "Search Wikipedia" },
      },
    },
  });
  const space = buildCandidates(page, "search", { Search: "query" });
  assert.equal(space.byOperation.get("TYPE")?.find((item) => item.ref === "@e1")?.valueKey, "Search");
  assert.equal(space.byOperation.get("TYPE")?.find((item) => item.ref === "@e2")?.valueKey, undefined);
});
