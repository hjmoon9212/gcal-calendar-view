/*
 * 노트 `Status` → 화면에 쓰는 글자·색·막대 모양. 화면(상태 칸·막대)과 툴팁이 이 한 곳을 쓴다.
 *
 * 강조는 최소로 — 상태 칸은 **글자와 글자색만**(배지·배경 없음), 막대는 색·흐림·점선으로만 가른다.
 */

export type BarKind = "active" | "planned" | "hold" | "done";

export interface StatusInfo {
  /** 상태 칸에 쓰는 짧은 글자. Status 가 없으면 "" */
  label: string;
  /** 상태 칸 글자색 */
  color: string;
  bar: BarKind;
}

export const STATUS_GREEN = "#2e9d5b";

const KNOWN: Record<string, StatusInfo> = {
  inprogress: { label: "진행", color: "var(--interactive-accent)", bar: "active" },
  planning: { label: "계획", color: "var(--text-muted)", bar: "planned" },
  hold: { label: "보류", color: "var(--text-faint)", bar: "hold" },
  done: { label: "완료", color: STATUS_GREEN, bar: "done" },
};

export function statusInfo(status: string | null | undefined): StatusInfo {
  const raw = String(status ?? "").trim();
  if (!raw) return { label: "", color: "inherit", bar: "active" };
  const k = raw.toLowerCase().replace(/[\s_-]/g, "");
  return KNOWN[k] ?? { label: Array.from(raw).slice(0, 2).join(""), color: "inherit", bar: "active" };
}

export const isDoneStatus = (status: string | null | undefined): boolean => statusInfo(status).bar === "done";
