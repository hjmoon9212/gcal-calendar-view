/*
 * 낙관적 갱신 대기표 — createCalendar 에서 그대로 옮겼다(0.7.2).
 *
 * 파일에 방금 쓴 줄을 Dataview 인덱스가 따라올 때까지 임시로 덮어쓴다. 이게 없으면
 * 쓰기 직후의 렌더가 옛 날짜로 그렸다가 인덱스 갱신 때 막대가 튄다.
 */

/** 인덱스가 끝내 안 따라오면 이 시간 뒤 자동 해제(ms) */
export const PENDING_TTL = 20000;

const SEP = String.fromCharCode(0);

/**
 * 대기표 키. **줄 번호가 반드시 들어간다** — title 은 날짜·태그·🆔 를 지운 값이라
 * 같은 파일에 제목이 똑같은 태스크(예: 매주 반복 로그)가 여러 개면 전부 같은 키가 되고,
 * 하나를 옮기면 나머지가 그 줄로 덮여 그려진 뒤 applyDates 가 엉뚱한 줄에 쓰게 된다.
 */
export const pkey = (path: string, line: number, title: string): string => path + SEP + line + SEP + title;

/**
 * 항목의 안정 식별자. task 는 파일+줄, GCal 일정은 피드가 준 uid 를 그대로 쓴다.
 * placeBars 의 레인 메모가 이 값을 키로 삼는다 — 일정에는 path·line 이 없기 때문이다.
 */
export const UID = (path: string, line: number): string => path + SEP + line;

export interface PendingEntry {
  text: string;
  ts: number;
}

/**
 * 만료된 대기표를 치운다. 그 줄을 다시 만나야 풀리는 구조라, 줄이 지워지면 영원히 남는다
 * → 수집할 때마다 일괄 청소한다.
 */
export function sweepPending(pending: Map<string, PendingEntry>, now: number, ttl = PENDING_TTL): void {
  for (const [k, v] of pending) if (now - v.ts > ttl) pending.delete(k);
}
