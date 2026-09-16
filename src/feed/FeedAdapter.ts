/*
 * GCal 일정을 가져오는 경계 — createCalendar 에서 그대로 옮겼다(0.7.3).
 *
 * 실제 Google Calendar 일정은 tasks-gcal-sync 가 받아온다 — 자격증명이 거기 있고, 여기에
 * OAuth 를 또 두면 refresh token 소비자가 둘이 되어 회전 때 경합한다.
 *
 * 매 렌더마다 플러그인을 다시 찾는다. 로드 순서는 보장되지 않고 사용자가 나중에 켤 수도 있다.
 * 버전이 아니라 **덕 타이핑**이라 구·신 버전이 섞여 있어도 깨지지 않고 그냥 없는 것처럼 동작한다.
 * null 이 되는 경우: 모바일(그쪽은 isDesktopOnly) · 미설치 · 구버전(api 없음) · 인증 전 ·
 * 고른 캘린더 0개. 전부 v0.1.13 과 동일한 화면이 된다.
 */
import { CalFilter, EventItem, eventCacheKey, passesCalFilter, toEventItem } from "./events";
import { Settings } from "../settings/defaults";

export interface FeedDeps {
  app: any;
  /** 노트를 닫으면 구독이 자동 해제되도록 렌더 수명에 건다. */
  component: { register: (cb: any) => void };
  settings: () => Settings;
  calFilter: CalFilter;
  /** 색 서명(캐시 키)에 쓰는 지금의 카테고리 */
  categories: () => { CATS: string[]; CATCOLOR: Record<string, string> };
  /** 「📅 일정」 칩이 켜져 있는가 */
  showEvents: () => boolean;
  /** 일정이 도착했을 때 다시 그린다. 화면에 붙어 있을 때만. */
  onChange: () => void;
  isAlive: () => boolean;
  eventColor: (e: any) => string;
}

export function createFeedAdapter(deps: FeedDeps) {
  // 일정은 gather() 에 넣지 않는다. 그쪽 캐시는 볼트 쓰기 때 무효화되는 물건이라
  // 거기 넣으면 일정이 영영 낡고, 대기표(pending) 스윕이 헛돈다. 별도 메모를 둔다.
  let evCache: { key: string; items: EventItem[] } | null = null;
  let feedVersion = 0; // 피드가 onChange 로 알릴 때마다 올린다
  let subscribed = false;

  /** 플러그인이 깔려 있고 API 모양이 맞는가 (준비 여부는 안 본다) */
  const feedPlugin = (): any => {
    try {
      const p = deps.app.plugins && deps.app.plugins.plugins && deps.app.plugins.plugins["tasks-gcal-sync"];
      const a = p && p.api;
      if (!a || typeof a.peekEvents !== "function" || typeof a.requestEvents !== "function") return null;
      return a;
    } catch (e) {
      return null; // 실패하면 없는 것으로 — 캘린더는 task 만 그린다(fail open)
    }
  };

  /** 지금 일정을 줄 수 있는가 (인증됨 + 고른 캘린더 1개 이상) */
  const feed = (): any => {
    const a = feedPlugin();
    try {
      return a && a.isReady() ? a : null;
    } catch (e) {
      return null;
    }
  };

  /**
   * 일정이 도착하면 다시 그리도록 구독한다. **처음 피드를 본 시점에** 건다 — 캘린더를 만들 때
   * 한 번만 시도하면, 나중에 인증하거나 캘린더를 고른 사용자는 다른 이유로 렌더가 일어날
   * 때까지 아무 일도 안 일어난 것처럼 보인다.
   */
  const subscribe = (f: any): void => {
    if (subscribed || !f || typeof f.onChange !== "function") return;
    subscribed = true;
    try {
      deps.component.register(
        f.onChange(() => {
          feedVersion++;
          if (deps.isAlive()) deps.onChange();
        })
      );
    } catch (e) {
      console.debug("[gcal-calendar-view] 일정 구독 실패 — 갱신은 렌더 때만 일어난다", e);
    }
  };

  const eventsFor = (fromISO: string, toISO: string): EventItem[] => {
    subscribe(feedPlugin()); // 준비 전에도 걸어 둔다 — 설정에서 캘린더를 고르면 알려 온다
    const f = feed();
    if (!f || !deps.showEvents() || deps.calFilter.off) return [];
    const { CATS, CATCOLOR } = deps.categories();
    const key = eventCacheKey(fromISO, toISO, feedVersion, CATS, CATCOLOR, deps.settings());
    // ★ 캐시가 맞아도 **먼저** 요청한다 (v0.2.7). 이 호출은 피드에게 "뷰가 이 구간을 보고
    //   있다" 를 알리는 유일한 신호다. 캐시 적중일 때 건너뛰었더니 조용한 구간에서 피드가 이
    //   창을 잊고 폴링을 멈췄고 — 폴링이 멈추면 달라질 일이 없으니 이 캐시도 영영 유효해서 —
    //   GCal 에서 지운 일정이 Obsidian 재시작 전까지 남았다(2026-09-07).
    //   실제 네트워크 호출 여부는 피드가 TTL 로 판단하므로 매 렌더 불러도 싸다.
    // 던지고 잊는다 — 도착하면 onChange 가 온다. 계약상 reject 하지 않지만, 플러그인 경계
    // 너머라 버전이 어긋날 수 있다. catch 가 없으면 그때 unhandled rejection 이 콘솔을 채운다.
    try {
      Promise.resolve(f.requestEvents(fromISO, toISO)).catch(() => {});
    } catch (_) {}
    if (evCache && evCache.key === key) return evCache.items;
    let items: EventItem[] = [];
    try {
      items = f
        .peekEvents(fromISO, toISO)
        .filter((e: any) => passesCalFilter(e, deps.calFilter))
        .map((e: any) => toEventItem(e, deps.eventColor(e)));
    } catch (e) {
      console.debug("[gcal-calendar-view] 일정 조회 실패 → task 만 그린다", e);
      items = [];
    }
    evCache = { key, items };
    return items;
  };

  return { feedPlugin, feed, eventsFor, passes: (e: any) => passesCalFilter(e, deps.calFilter) };
}
