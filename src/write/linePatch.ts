/*
 * 노트 줄을 고치는 규칙 — createCalendar 에서 그대로 옮겼다(0.7.2).
 *
 * ⛔ 이 플러그인이 노트 본문을 만지는 곳은 여기 하나다(호출은 write/ 의 쓰기 경로에서만).
 *    🛫·📅 는 있으면 치환하고 없으면 뒤에 붙이지만, **⏰ 는 반드시 첫 필드 이모지 앞**이다
 *    → core/time.ts 의 주석(Tasks 8.3.0 파싱)을 먼저 읽을 것.
 */
import { FIELD_EMOJI, timeReStrip } from "../core/time";

export interface LineChanges {
  start?: string;
  due?: string;
  /** null 이면 ⏰ 를 제거한다. */
  time?: string | null;
}

/** 한 줄에 변경을 적용한다. 파일의 줄과 task.text 에 똑같이 태워 쓴다. */
export function patchLine(ln: string, changes: LineChanges): string {
  if (changes.start !== undefined) {
    if (/🛫\s*\d{4}-\d{2}-\d{2}/.test(ln)) ln = ln.replace(/🛫\s*\d{4}-\d{2}-\d{2}/, "🛫 " + changes.start);
    else ln = ln.replace(/\s*$/, "") + " 🛫 " + changes.start;
  }
  if (changes.due !== undefined) {
    if (/📅\s*\d{4}-\d{2}-\d{2}/.test(ln)) ln = ln.replace(/📅\s*\d{4}-\d{2}-\d{2}/, "📅 " + changes.due);
    else ln = ln.replace(/\s*$/, "") + " 📅 " + changes.due;
  }
  // ⏰ 는 마지막에 처리한다 — 위에서 📅/🛫 를 새로 붙였을 수 있고, 시각은 그것들보다 앞에 와야 한다.
  if (changes.time !== undefined) {
    const cleaned = ln.replace(timeReStrip(), "");
    if (changes.time === null) ln = cleaned;
    else {
      const field = "⏰ " + changes.time;
      const m = cleaned.match(FIELD_EMOJI);
      // 첫 Tasks 필드 이모지 앞에 삽입. 줄 끝 append 는 Tasks 파싱을 깨뜨리므로 금지
      // (필드 정규식이 "$" 앵커라, 끝에 모르는 토큰이 있으면 그 앞 필드까지 안 읽힌다).
      ln = m
        ? cleaned.slice(0, m.index).replace(/\s*$/, "") + " " + field + " " + cleaned.slice(m.index)
        : cleaned.replace(/\s*$/, "") + " " + field;
    }
  }
  return ln;
}

/**
 * 파일의 줄 배열에서 이 태스크의 실제 줄 인덱스를 찾는다. 못 찾으면 -1.
 * task.line 이 맞으면 그대로 쓰고, 어긋났으면(외부 편집으로 줄이 밀렸을 때) text 로 재탐색한다.
 * ⚠️ 확인 없이 task.line 을 그냥 쓰면 태스크가 아닌 줄을 덮어쓴다 → 호출부는 반드시 -1 을 처리할 것.
 */
export const findTaskLine = (lines: string[], task: { line: number; text: string }): number => {
  const i = task.line;
  if (lines[i] !== undefined && lines[i].includes(task.text)) return i;
  return lines.findIndex((l) => l.includes(task.text));
};
