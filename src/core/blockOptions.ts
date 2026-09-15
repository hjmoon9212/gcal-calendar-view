/* 코드블록 옵션 · 캘린더 필터 · 수집 스코프 — main.js 에서 그대로 옮겼다(0.7.1). */
/**
 * 코드블록 본문 파싱: `scope: vault` · `source: <쿼리>` · `note: <설명>`
 * (빈 블록이면 폴더 스코프)
 *
 * `note` 만 여러 줄을 허용해 배열로 모은다 — 설명이 길면 줄을 나눠 쓰는 게 자연스럽다.
 */
export function parseOptions(src: any) {
    const o: { note: string[]; [key: string]: any } = { note: [] };
    for (const raw of (src || "").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const i = line.indexOf(":");
        if (i < 0) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        const val = line.slice(i + 1).trim();
        if (key === "note") {
            if (val) o.note.push(val);
        } else {
            o[key] = val;
        }
    }
    return o;
}

/**
 * 쉼표로 나열한 값 → 배열. 빈 항목은 버린다.
 * `calendars: Growth, Routine` 처럼 한 줄에 여러 개를 적는 옵션에 쓴다.
 */
export function parseList(v: any) {
    return String(v || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

/** 캘린더 이름 비교용 정규화. 사람이 손으로 적는 값이라 대소문자·공백을 무시한다. */
export const calKey = (s: any) => String(s || "").trim().toLowerCase();

/**
 * 블록별 GCal 일정 필터.
 *
 *   gcal: Growth, Routine     ← 이 캘린더의 일정만 (화이트리스트)
 *   gcal-exclude: Event       ← 이것만 빼기 (블랙리스트)
 *   gcal: off                 ← 이 블록에서는 일정을 아예 안 그린다
 *
 * 이름을 `gcal` 로 잡은 이유: 값이 `#gcal/Growth` 라우팅 태그의 이름과 **글자 그대로
 * 같다.** 노트에서 쓰던 말을 그대로 쓰므로 따로 외울 게 없고, `gcal` 은 구글 캘린더
 * 쪽만 가리켜서 위젯 자체나 task 와 헷갈릴 여지가 없다.
 * (`calendars:` 는 "이 캘린더 위젯" 으로 읽혀 무엇을 거르는지가 안 보였다 → 별칭으로만 남긴다)
 *
 * 둘 다 적으면 화이트리스트를 먼저 적용하고 거기서 블랙리스트를 뺀다.
 * **동기화 플러그인 설정에서 고른 캘린더의 부분집합**이다 — 여기 적었다고 안 고른
 * 캘린더를 가져오지는 않는다(가져올 자격증명·조회는 그쪽이 한다).
 */
export function resolveCalFilter(opts: any) {
    // 먼저 정의된 것이 이긴다. 뒤쪽 둘은 0.2.3 의 옛 이름(별칭).
    const pick = (...keys: string[]) => {
        for (const k of keys) if (opts[k] !== undefined) return opts[k];
        return undefined;
    };
    const rawInc = pick("gcal", "calendars", "include-calendars");
    const off = ["none", "off", "-"].includes(calKey(rawInc));
    return {
        off,
        include: off ? [] : parseList(rawInc).map(calKey),
        // `exclude:` 단독은 일부러 안 받는다 — 폴더/소스 제외로 읽히기 쉽다.
        // 빼는 대상이 GCal 캘린더라는 걸 이름에 남긴다.
        exclude: parseList(pick("gcal-exclude", "exclude-calendars")).map(calKey),
    };
}

/**
 * 수집 스코프를 정한다. Template 폴더는 항상 제외한다 — 템플릿의 예시 task 가
 * 캘린더에 섞이면 안 된다.
 */
export function resolveSource(opts: any, sourcePath: any) {
    if (opts.source) return opts.source;
    if ((opts.scope || "").toLowerCase() === "vault") return '!"Template"';
    const folder = (sourcePath || "").split("/").slice(0, -1).join("/");
    return folder ? '"' + folder + '" and !"Template"' : '!"Template"';
}
