/* 하루 안의 정렬 — 모든 표면이 같은 비교자를 쓴다 — main.js 에서 그대로 옮겼다(0.7.1). */
/** 읽기 전용 항목인가(📆 GCal 일정). 이 하나로 모든 쓰기·이동 경로를 막는다. */
export function isRO(t: any) {
    return !!t && t.kind === "event";
}

/**
 * **하루 안에서의 정렬 순위.** 낮을수록 먼저.
 *
 *   0 — 📆 GCal **종일** 일정. 회의·당일 주요 약속이 대부분이라 **그날의 뼈대**다.
 *       시각이 없으니 시간순으로는 자리를 못 잡는데, 정작 먼저 봐야 하는 것들이다
 *   1 — 시각이 있는 항목(task·일정 공통). 그 안에서는 **시각순**(예전 규칙 그대로)
 *   2 — 그 밖 = 종일 task
 *
 * ⚠️ **날짜 비교보다 뒤에 온다.** 여러 날에 걸친 막대는 시작일이 먼저 정렬을 잡아야
 *    레인이 주 경계를 넘어 이어진다 — 이 순위는 **같은 날 안에서만** 쓴다.
 */
export function dayRank(t: any) {
    return isRO(t) && t.tStart === null ? 0 : t.tStart !== null ? 1 : 2;
}

/**
 * 같은 날 안의 비교자. 순위 → 시각 → 마감일.
 *
 * **정렬하는 모든 표면이 이걸 쓴다** — 데스크탑 막대·일간 종일 스트립, 모바일 일간·
 * 날짜별 목록·고른 날 카드. 표면마다 따로 적으면 같은 하루가 화면마다 다른 순서로 보인다.
 * 순수 계산이라 테스트할 수 있다(__test).
 */
export function byDayOrder(a: any, b: any) {
    const ra = dayRank(a), rb = dayRank(b);
    if (ra !== rb) return ra - rb;
    if (a.tStart !== null && b.tStart !== null) {
        if (a.tStart !== b.tStart) return a.tStart - b.tStart;
        if (a.tEnd !== b.tEnd) return a.tEnd - b.tEnd;
    }
    return (a.due || "") < (b.due || "") ? -1 : (a.due || "") > (b.due || "") ? 1 : 0;
}
