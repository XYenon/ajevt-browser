import type { Candidate, Observation } from "./types.js";

const COMMITMENT =
  /\b(?:pay|payment|purchase|buy|checkout|send|delete|publish|register|apply|transfer|confirm order|place order|submit application|cancel subscription|close account|remove (?:account|user|member|payment|card))\b|支付|购买|结算|发送|删除|发布|注册|申请|转账|注销|付款/iu;
const SAFE_ACTION =
  /\b(?:submit (?:search|query)|save (?:filter|search|view|preference|draft)|confirm (?:selection|choice)|remove (?:filter|selection|tag))\b|提交搜索|保存(?:筛选|过滤|草稿)|确认(?:选择|选项)|移除(?:筛选|过滤|标签)/iu;
const AMBIGUOUS_ACTION = /\b(?:save|submit|confirm|remove)\b|保存|提交|确认|确定|移除/iu;

export type RiskClassification = "safe" | "risky" | "uncertain";

export function classifyActionRisk(candidate: Candidate, goal: string, observation: Observation): RiskClassification {
  if (
    candidate.operation === "TYPE" ||
    candidate.operation === "SELECT" ||
    candidate.operation === "SCROLL" ||
    candidate.operation === "WAIT" ||
    candidate.operation === "BACK"
  )
    return "safe";
  const name = observation.elements.find((element) => element.ref === candidate.ref)?.name ?? candidate.label;
  if (COMMITMENT.test(name)) return "risky";
  if (COMMITMENT.test(goal) || COMMITMENT.test(observation.title)) return "risky";
  if (SAFE_ACTION.test(name)) return "safe";
  if (!AMBIGUOUS_ACTION.test(name) && !(candidate.operation === "PRESS" && candidate.key === "Enter")) return "safe";
  // A generic confirmation or Enter key can submit the entire current form.
  // Use the caller's purpose and page heading, not arbitrary untrusted body text.
  if (/(?:search|query|filter|selection|choice|draft|搜索|查询|筛选|过滤|选择|草稿)/iu.test(goal)) return "safe";
  return "uncertain";
}
