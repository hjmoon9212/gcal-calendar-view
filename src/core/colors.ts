/* GCal 일정 색 — 설정 화면과 렌더가 같은 함수를 쓴다 — main.js 에서 그대로 옮겼다(0.7.1). */
import { calKey } from "./blockOptions";

export const HEX6_RE = /^#[0-9a-fA-F]{6}$/;
export const okHex = (v: any) => (HEX6_RE.test(String(v || "")) ? String(v).toLowerCase() : null);

/**
 * GCal 일정 하나의 색과 **그 색이 어디서 왔는지**. 설정 화면과 렌더가 같은 함수를 쓴다 —
 * 설정에 보이는 색과 화면에 그려지는 색이 갈라지면 그것만으로 버그다.
 *
 * 우선순위:
 *   1) eventColors[캘린더 id]        직접 지정
 *   2) 같은 이름의 카테고리 색        기본 — task 막대와 저절로 맞는다
 *   3) eventColor                    카테고리가 없는 캘린더(예: Holidays in South Korea)
 */
export function resolveEventColorInfo(settings: any, catColor: any, calId: any, calName: any) {
    const own = okHex((settings.eventColors || {})[calId]);
    if (own) return { color: own, source: "직접 지정", cat: null };
    const key = calKey(calName);
    const byCat = okHex((catColor || {})[key]);
    if (byCat) return { color: byCat, source: `카테고리 «${key}» 따름`, cat: key };
    return {
        color: okHex(settings.eventColor) || "#7f8c8d",
        source: "기본 색 따름 (같은 이름의 카테고리 없음)",
        cat: null,
    };
}
export const resolveEventColor = (settings: any, catColor: any, calId: any, calName: any) =>
    resolveEventColorInfo(settings, catColor, calId, calName).color;

/** 설정 화면에서 쓸 카테고리 색 맵 (key → color). createCalendar 밖에서도 필요하다. */
export function categoryColorMap(settings: any) {
    const m: Record<string, string> = {};
    for (const c of settings.categories || []) if (c && c.key) m[calKey(c.key)] = c.color;
    return m;
}
