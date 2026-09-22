const RISKY_ACTION_TERMS = [
  "pay",
  "purchase",
  "buy",
  "checkout",
  "send",
  "delete",
  "remove",
  "publish",
  "register",
  "apply",
  "transfer",
  "confirm order",
  "place order",
  "submit application",
  "save",
  "submit",
  "confirm",
  "支付",
  "购买",
  "结算",
  "发送",
  "删除",
  "移除",
  "发布",
  "注册",
  "申请",
  "转账",
  "保存",
  "提交",
  "确认",
  "确定",
] as const;

const ACTION_REQUEST_TERMS = ["click", "select", "execute", "点击", "选择", "执行"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termsPattern(terms: readonly string[]): RegExp {
  const english: string[] = [];
  const other: string[] = [];
  for (const term of terms) {
    const isAscii = [...term].every((character) => character.charCodeAt(0) <= 0x7f);
    (isAscii ? english : other).push(escapeRegExp(term));
  }
  const parts = [
    english.length ? `\\b(?:${english.join("|")})\\b` : "",
    other.length ? `(?:${other.join("|")})` : "",
  ].filter(Boolean);
  return new RegExp(parts.join("|"), "iu");
}

const RISKY_ACTION_PATTERN = termsPattern(RISKY_ACTION_TERMS);
export function isRiskyActionLabel(label: string): boolean {
  return RISKY_ACTION_PATTERN.test(label);
}

export function requestsActionOnLabel(goal: string, label: string): boolean {
  const normalizedLabel = label.trim();
  if (!normalizedLabel) return false;
  return goal
    .split(/[。；;，,\n]/u)
    .some(
      (clause) =>
        clause.toLowerCase().includes(normalizedLabel.toLowerCase()) &&
        ACTION_REQUEST_TERMS.some((term) => clause.toLowerCase().includes(term.toLowerCase())),
    );
}
