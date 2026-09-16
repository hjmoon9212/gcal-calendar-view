/*
 * 날짜만 다루는 계산 — createCalendar 에서 그대로 옮겼다(0.7.2).
 *
 * 전부 **UTC 자정 기준**이다. 로컬 시각으로 더하면 서머타임이 있는 지역에서 하루가 밀린다.
 * 화면에 보이는 "오늘"(todayISO)은 luxon 이 로컬로 계산해 넘겨준다 — 여기서는 문자열만 만진다.
 */

/** ISO 날짜에 n 일을 더한다. */
export const addDays = (iso: string, n: number): string => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** a - b (일). 기간 길이를 보존한 채 막대를 옮길 때 쓴다. */
export const diffDays = (a: string, b: string): number =>
  Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);

/** 주의 시작(일요일)으로 내린다. luxon DateTime 을 받아 그대로 돌려준다. */
export const sundayStart = <T extends { weekday: number; minus: (o: any) => T }>(d: T): T =>
  d.minus({ days: d.weekday % 7 });

/** 항목이 차지하는 날짜 구간 [from, to]. 둘 다 없으면 null (= 날짜 없음). */
export const spanOf = (t: { start?: string | null; due?: string | null }): [string, string] | null => {
  const a = t.start || t.due;
  const b = t.due || t.start;
  if (!a || !b) return null;
  return a <= b ? [a, b] : [b, a];
};

/** 모바일 월간 그리드의 점 — 🛫 만 있는 줄도 그 날에 걸린 것으로 본다. */
export const coversDay = (t: { start?: string | null; due?: string | null }, iso: string): boolean => {
  const s = spanOf(t);
  return !!s && s[0] <= iso && iso <= s[1];
};

/**
 * 달력이 그리는 기준. **📅 가 있어야 한다** — 기간의 왼쪽 끝은 🛫 가 있으면 그것, 없으면 📅 다.
 * 일간(하루)과 주간(구간)이 같은 규칙을 쓴다.
 */
export const overlapsRange = (
  t: { start?: string | null; due?: string | null },
  fromISO: string,
  toISO: string
): boolean => !!t.due && (t.start || t.due)! <= toISO && t.due >= fromISO;

export const onDay = (t: { start?: string | null; due?: string | null }, iso: string): boolean =>
  overlapsRange(t, iso, iso);
