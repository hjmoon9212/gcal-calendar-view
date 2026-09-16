/*
 * ⏰ 타임블록의 문법과 분(minute) 계산 — createCalendar 에서 그대로 옮겼다(0.7.2).
 *
 * 문법: ⏰ HH:MM-HH:MM (종료 생략 시 시작 + DEFAULT_MIN 분)
 *
 * ⚠️ 줄에 새로 넣을 때는 반드시 "첫 Tasks 필드 이모지 앞"에 삽입한다. 줄 끝에 붙이면 안 된다.
 *    Tasks 8.3.0 은 필드 정규식을 전부 "$" 앵커로 만들고(Da()), deserialize() 가 줄 끝에서부터
 *    하나씩 벗겨내는 do-while 루프다. 끝에 Tasks 가 모르는 토큰이 있으면 첫 바퀴에 아무것도
 *    매치되지 않아 루프가 끝나고, 그 앞의 📅🛫 까지 통째로 설명(description)으로 흡수된다
 *    → 마감일 기반 쿼리·정렬이 그 태스크를 놓친다.
 * 그래서 시각은 사용자가 타이핑하지 않고 일간 보기 드래그로만 설정한다(위치를 코드가 통제).
 */
export const TIME_PAT = "\\u{23F0}\\s*(\\d{1,2}:\\d{2})(?:\\s*-\\s*(\\d{1,2}:\\d{2}))?";
export const timeRe = (): RegExp => new RegExp(TIME_PAT, "u");
export const timeReStrip = (): RegExp => new RegExp("\\s*" + TIME_PAT, "gu");
/** 첫 Tasks 필드 이모지 = 삽입 기준점 (우선순위 이모지 포함) */
export const FIELD_EMOJI = /[\u{1F4C5}\u{1F4C6}\u{1F5D3}\u{1F6EB}\u{23F3}\u{231B}\u{2705}\u{2795}\u{274C}\u{1F501}\u{1F194}\u{26D4}\u{1F3C1}\u{1F53A}\u{23EB}\u{1F53C}\u{1F53D}\u{23EC}]/u;
/** 종료 시각이 없을 때의 기본 길이 */
export const DEFAULT_MIN = 60;
/** 드래그 스냅 단위(분) */
export const SNAP_MIN = 15;

export const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const toHHMM = (min: number): string => {
  const x = Math.max(0, Math.min(1439, Math.round(min)));
  return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0");
};
export const snapMin = (m: number): number => Math.round(m / SNAP_MIN) * SNAP_MIN;
export const timeText = (s: number, e: number): string => toHHMM(s) + "-" + toHHMM(e);

/**
 * 줄에서 ⏰ 를 읽는다. 종료가 없거나 역전돼 있으면 기본 길이로 보정한다
 * (막대 높이가 0/음수가 되지 않게). 없으면 둘 다 null.
 */
export function parseTimeField(text: string): { tStart: number | null; tEnd: number | null } {
  const tm = text.match(timeRe());
  if (!tm) return { tStart: null, tEnd: null };
  const tStart = Math.min(1439, toMin(tm[1]));
  let tEnd = tm[2] ? toMin(tm[2]) : tStart + DEFAULT_MIN;
  if (tEnd <= tStart) tEnd = tStart + DEFAULT_MIN;
  return { tStart, tEnd: Math.min(1440, tEnd) };
}
