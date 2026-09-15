/* 플러그인 설정의 기본값 — main.js 에서 그대로 옮겼다(0.7.1). */
export interface Category {
  key: string;
  label: string;
  color: string;
}

export interface Settings {
  categories: Category[];
  defaultCategory: string;
  eventColors: Record<string, string>;
  eventColor: string;
  mobileUi: "auto" | "always" | "off";
  [key: string]: any;
}

export const DEFAULT_SETTINGS: Settings = {
    // 기본값은 개인 볼트 기준. 업무 볼트처럼 카테고리가 하나면 설정에서 지우면 된다.
    categories: [
        { key: "work", label: "Work", color: "#3f51b5" },
        { key: "growth", label: "Growth", color: "#0b8043" },
        { key: "routine", label: "Routine", color: "#9e69af" },
        { key: "personal", label: "Personal", color: "#e67c73" },
        { key: "hobby", label: "Hobby", color: "#e4c441" },
        { key: "event", label: "Event", color: "#a2845e" },
        { key: "non-core", label: "Non-core", color: "#a79b8e" },
    ],
    defaultCategory: "personal",
    // ── GCal 일정(읽기 전용)의 색 ──
    // **색은 전부 이 플러그인이 소유한다.** 그리는 쪽이 색을 갖는 게 맞고, 카테고리 색과
    // 한 화면에 있어야 "task 막대와 회의 막대를 같은 색으로" 를 눈으로 맞출 수 있다.
    // tasks-gcal-sync 는 "어느 캘린더를 가져올지" 만 정한다.
    //
    // eventColors: 캘린더 id → "#rrggbb". 여기 있으면 그 색을 쓴다(직접 지정).
    //              없으면 같은 이름의 카테고리 색 → 그것도 없으면 eventColor.
    eventColors: {},
    // 같은 이름의 카테고리가 없는 캘린더의 색 (예: "Holidays in South Korea")
    eventColor: "#7f8c8d",
    // ── 모바일 화면 ──
    // "auto" = 폰이면 모바일 화면(Platform.isPhone). "always"/"off" 로 강제할 수 있다.
    // 강제가 필요한 이유가 둘: 태블릿은 isPhone 이 false 라 데스크탑 화면을 받고,
    // 모바일 화면을 고칠 때 폰을 들지 않고 데스크탑에서 바로 볼 수 있어야 한다.
    mobileUi: "auto",   // "auto" | "always" | "off"
};
