/*
 * 노트 프로퍼티 → Gantt 그룹 막대의 구간. 순수 계산이라 DOM 도 설정도 안 본다.
 *
 * 실제 두 볼트의 데이터가 규칙을 정했다:
 *   · 시작은 `StartDate` 하나
 *   · 끝은 `EndDate`(Hub·Book·제안서) 와 `DueDate`(Module·Milestone·Issue) 가 **섞여 있다**
 *   · 빈 값이 흔하다(진행 중인 책의 EndDate, 날짜 미정 이슈의 DueDate)
 * 그래서 끝은 "앞에서부터 먼저 값이 있는 것" 이고, 비면 그 노트의 task 로 메운다.
 */

const DATE_HEAD = /^(\d{4}-\d{2}-\d{2})/;

/**
 * 프로퍼티 값 하나 → YYYY-MM-DD. 못 읽으면 null.
 *
 * 받는 모양: `"2026-08-12"` · `"2026-08-12T09:00"` · Dataview/luxon DateTime(`toISODate()`) ·
 * JS Date. 링크·빈칸·숫자 같은 나머지는 **없는 것**으로 본다 — 틀린 날짜로 그리는 것보다 낫다.
 */
export function toISODate(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const m = v.trim().match(DATE_HEAD);
    return m && isRealDate(m[1]) ? m[1] : null;
  }
  if (typeof v === "object") {
    if (typeof v.toISODate === "function") {
      try {
        const s = v.toISODate();
        return typeof s === "string" && isRealDate(s) ? s : null;
      } catch (e) {
        return null;
      }
    }
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
      const p = (n: number) => String(n).padStart(2, "0");
      return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
  }
  return null;
}

/** 2026-02-30 같은 넘침을 거른다. */
function isRealDate(iso: string): boolean {
  const d = new Date(iso + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/**
 * 프로퍼티를 이름으로 찾는다 — **대소문자 무시**. 사람이 손으로 적는 키라 `startDate`/`StartDate`
 * 가 섞이고, Dataview 는 소문자 사본을 따로 만든다.
 */
export function getProp(obj: any, name: string): any {
  if (!obj || typeof obj !== "object" || !name) return undefined;
  if (name in obj) return obj[name];
  const want = name.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === want) return obj[k];
  return undefined;
}

/** 여러 이름 중 앞에서부터 **날짜로 읽히는** 첫 값. */
export function firstDate(obj: any, names: string[]): string | null {
  for (const n of names) {
    const d = toISODate(getProp(obj, n));
    if (d) return d;
  }
  return null;
}

export interface NoteSpan {
  start: string;
  end: string;
  /**
   * 끝이 **정해지지 않은** 기간 — 프로퍼티도 task 도 끝을 말해 주지 않아 오늘까지 그린 것.
   * 화면은 오른쪽을 흐리게 이어 "아직 진행 중" 임을 보인다.
   */
  open: boolean;
}

/**
 * 노트 막대의 구간. 날짜가 하나도 없으면 null(= 📭 날짜 없음).
 *
 * @param propStart 프로퍼티 시작(없으면 null)
 * @param propEnd   프로퍼티 끝(없으면 null)
 * @param taskSpans 그 노트 task 들의 [시작, 끝] (날짜 있는 것만)
 * @param today     열린 기간을 닫을 날
 */
export function noteSpan(
  propStart: string | null,
  propEnd: string | null,
  taskSpans: [string, string][],
  today: string
): NoteSpan | null {
  let tMin: string | null = null;
  let tMax: string | null = null;
  for (const [a, b] of taskSpans) {
    if (!tMin || a < tMin) tMin = a;
    if (!tMax || b > tMax) tMax = b;
  }

  let start = propStart ?? tMin;
  // task 로 끝을 메울 때는 시작 이후의 것만 — 시작 전에 끝난 task 로 닫으면 막대가 뒤집힌다.
  let end = propEnd ?? (tMax && (!start || tMax >= start) ? tMax : null);
  let open = false;

  if (!start && !end) return null;
  if (!end) {
    // 시작만 있다 → 끝이 안 정해진 진행 중. 시작이 미래면 하루짜리로 둔다(오늘까지 거꾸로 그리지 않게).
    if (start! <= today) {
      end = today;
      open = true;
    } else end = start;
  }
  if (!start) start = propEnd ? (tMin && tMin <= propEnd ? tMin : propEnd) : end;
  // 시작 > 끝이면 뒤집는다 — 음수 폭은 CSS 에서 무효가 된다(캘린더의 spanOf 와 같은 규칙).
  if (start! > end!) [start, end] = [end, start];
  return { start: start!, end: end!, open };
}
