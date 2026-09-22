import type { Observation, Verifier } from "./types.js";

export function verify(observation: Observation, verifiers: Verifier[] = []) {
  const checks = verifiers.map((check) => {
    let passed = false;
    let detail = "";
    switch (check.type) {
      case "url_contains":
        passed = observation.url.toLowerCase().includes(check.text.toLowerCase());
        detail = `URL contains ${JSON.stringify(check.text)}`;
        break;
      case "url_matches": {
        const escaped = check.pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".");
        passed = new RegExp(`^${escaped}$`, "i").test(observation.url);
        detail = `URL matches ${JSON.stringify(check.pattern)}`;
        break;
      }
      case "text_contains":
        passed = observation.text.toLowerCase().includes(check.text.toLowerCase());
        detail = `page text contains ${JSON.stringify(check.text)}`;
        break;
      case "text_absent":
        passed = !observation.text.toLowerCase().includes(check.text.toLowerCase());
        detail = `page text omits ${JSON.stringify(check.text)}`;
        break;
      case "element_exists":
      case "element_gone": {
        const found = observation.elements.some(
          (element) =>
            (!check.role || element.role === check.role.toLowerCase()) &&
            (!check.name || element.name.toLowerCase().includes(check.name.toLowerCase())),
        );
        passed = check.type === "element_exists" ? found : !found;
        detail = `${check.type}: role=${check.role ?? "*"} name=${check.name ?? "*"}`;
        break;
      }
      case "value_equals": {
        const element = observation.elements.find((item) => item.ref === check.ref);
        passed = element?.value === check.value;
        detail = `${check.ref} has expected value`;
        break;
      }
      case "element_value_equals": {
        const element = observation.elements.find(
          (item) =>
            (!check.role || item.role === check.role.toLowerCase()) &&
            item.name.toLowerCase().includes(check.name.toLowerCase()),
        );
        passed = element?.value === check.value;
        detail = `role=${check.role ?? "*"} name=${check.name} has expected value`;
        break;
      }
      case "checked": {
        const element = observation.elements.find((item) => item.ref === check.ref);
        passed = element?.checked === (check.state ?? true);
        detail = `${check.ref} checked=${check.state ?? true}`;
        break;
      }
    }
    return { type: check.type, passed, detail };
  });
  return { passed: checks.length > 0 && checks.every((check) => check.passed), checks };
}
