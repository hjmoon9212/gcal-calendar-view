/*
 * 모바일 일간이 그릴 시간대 — createCalendar 에서 그대로 옮겼다(0.7.2).
 *
 * 폰에서는 **안쪽 스크롤 박스를 만들지 않는다**(노트 스크롤과 싸운다). 대신 그릴 시간대를
 * 좁힌다 — 기본 08~20시, 항목이나 현재 시각이 벗어나면 그만큼 넓힌다.
 */
export function mobileHourRange(
  timed: { tStart: number | null; tEnd: number | null }[],
  opts: { fullDay: boolean; nowHour: number | null }
): [number, number] {
  let h0 = 24;
  let h1 = 0;
  for (const t of timed) {
    h0 = Math.min(h0, Math.floor(t.tStart! / 60));
    h1 = Math.max(h1, Math.ceil(t.tEnd! / 60));
  }
  if (opts.nowHour !== null) {
    h0 = Math.min(h0, opts.nowHour);
    h1 = Math.max(h1, opts.nowHour + 1);
  }
  if (h0 > h1) {
    h0 = 8;
    h1 = 20;
  } // 이 날에 아무것도 없을 때
  h0 = opts.fullDay ? 0 : Math.max(0, Math.min(h0, 8));
  h1 = opts.fullDay ? 24 : Math.min(24, Math.max(h1, 20));
  return [h0, h1];
}
