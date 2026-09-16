/*
 * 카테고리 목록·색·필터 유지 — createCalendar 에서 그대로 옮겼다(0.7.2).
 *
 * ⚠️ **매 렌더 다시 읽어야 한다.** dataviewjs 시절에는 인덱스가 바뀔 때마다 스크립트가 통째로
 *    재실행돼 자동으로 최신 설정이 반영됐지만, 플러그인에서는 createCalendar() 가 한 번만 돌고
 *    이후엔 renderNow() 만 다시 돈다 — 굳혀 두면 설정을 바꿔도 껐다 켜야 반영된다.
 */
import { Settings } from "../settings/defaults";

export interface CategoryView {
  CATS: string[];
  CATLABEL: Record<string, string>;
  CATCOLOR: Record<string, string>;
  CAT_DEFAULT: string;
}

/** 캘린더별로 이어지는 상태 중 카테고리가 쓰는 것. */
export interface CategoryState {
  cats?: string[];
  knownCats?: string[];
}

/**
 * 설정을 다시 읽어 목록·라벨·색을 만들고, 활성 필터(activeCats)를 제자리에서 맞춘다.
 *
 * 설정에서 사라진 카테고리는 필터에서도 뺀다. 설정에 "새로 생긴" 카테고리는 켠 채로 시작한다 —
 * 방금 만든 카테고리가 안 보이면 버그로 읽힌다.
 *
 * "새로 생겼는지" 는 반드시 지난번 카테고리 **목록**(state.knownCats)과 견줘야 한다. 활성
 * 목록(state.cats)과 견주면 꺼 둔 카테고리와 처음 보는 카테고리를 구분하지 못해 꺼 둔 게 다음
 * 렌더에 되살아난다. 클릭 한 번이 곧 렌더 한 번이라, 두 번째로 끄는 순간 첫 번째가 켜져서
 * "한 번에 하나만 꺼진다" 로 나타났다(0.1.12 에서 수정).
 */
export function syncCategories(
  settings: Settings,
  state: CategoryState,
  activeCats: Set<string>
): CategoryView {
  const cats = settings.categories.filter((c) => c.key);
  const CATS = cats.map((c) => c.key);
  const CATLABEL = Object.fromEntries(cats.map((c) => [c.key, c.label || c.key]));
  // 색은 실제 Google Calendar 의 커스텀 색 HEX 를 그대로 쓴다.
  const CATCOLOR = Object.fromEntries(cats.map((c) => [c.key, c.color]));
  const CAT_DEFAULT = settings.defaultCategory || CATS[0] || "";
  const saved = Array.isArray(state.cats) ? state.cats : null;
  // knownCats 가 없는 첫 실행: 이미 저장된 필터가 있으면 지금 목록을 다 아는 것으로 친다
  // (안 그러면 업데이트 직후 꺼 둔 게 한 번 되살아난다). 저장분이 아예 없으면 전부 켠다.
  const known = Array.isArray(state.knownCats) ? state.knownCats : saved ? CATS : null;
  for (const c of [...activeCats]) if (!CATS.includes(c)) activeCats.delete(c);
  for (const c of CATS) if (!known || !known.includes(c)) activeCats.add(c);
  state.knownCats = [...CATS];
  return { CATS, CATLABEL, CATCOLOR, CAT_DEFAULT };
}
