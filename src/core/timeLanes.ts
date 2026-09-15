/* 겹치는 시간 블록의 좌우 레인 배치 — 데스크탑 일간 · 모바일 타임라인 공유 — main.js 에서 그대로 옮겼다(0.7.1). */
/**
 * 겹치는 시간 블록을 좌우 레인으로 나눈다. 반환: `[{t, lane, lanes, span}]`.
 *
 * 레인 수는 반드시 **"겹치는 무리(cluster)" 안에서만** 센다 — 하루 전체로 세면 오전에
 * 3중 겹침이 한 번 있었다는 이유로 저녁 단독 일정까지 1/3 폭이 된다.
 * 무리 경계: 시작 시각이 지금 무리의 최대 종료 **이상**이면 끊는다(맞닿음은 겹침이 아니다).
 *
 * 데스크탑 일간 보기와 모바일 타임라인이 **같은 배치**를 쓰도록 여기 한 곳에 둔다.
 * 순수 계산이라 DOM 도 설정도 보지 않는다 — 그래서 테스트할 수 있다(__test).
 */
export function layoutTimeLanes(timed: any) {
    const items = [...timed].sort((a, b) => a.tStart - b.tStart || a.tEnd - b.tEnd);
    const laneEnd: number[] = [];
    const placed: { t: any; lane: number; lanes: number; span: number }[] = [];
    let cluster: { t: any; lane: number }[] = [];          // 지금 무리에 담긴 항목 (레인 수가 확정되면 placed 로 넘어간다)
    let clusterEnd = -1;
    const closeCluster = () => {
        const lanes = Math.max(laneEnd.length, 1);
        for (const it of cluster) {
            // 오른쪽 레인이 이 블록의 시간대 내내 비어 있으면 그만큼 넓힌다.
            // first-fit 이 레인을 앞에서부터 채우므로 자주 발동하진 않는다.
            let span = 1;
            while (it.lane + span < lanes &&
                !cluster.some(o => o.lane === it.lane + span && o.t.tStart < it.t.tEnd && o.t.tEnd > it.t.tStart)) span++;
            placed.push({ t: it.t, lane: it.lane, lanes, span });
        }
        cluster = [];
        laneEnd.length = 0;
    };
    for (const t of items) {
        if (t.tStart >= clusterEnd) { closeCluster(); clusterEnd = t.tEnd; }
        else clusterEnd = Math.max(clusterEnd, t.tEnd);
        let lane = laneEnd.findIndex((e) => e <= t.tStart);
        if (lane === -1) { lane = laneEnd.length; laneEnd.push(t.tEnd); }
        else laneEnd[lane] = t.tEnd;
        cluster.push({ t, lane });
    }
    closeCluster();            // 마지막 무리 — 빠뜨리면 하루의 끝 일정이 그려지지 않는다
    return placed;
}
