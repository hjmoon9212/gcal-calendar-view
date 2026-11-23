/*
 * 탭(클릭)이 무엇을 여는가 — **화면(렌더러)과 따로** 정한다(0.11.1~).
 *
 * 화면은 폭이 정한다: 폰은 모바일 화면, 태블릿·PC 는 데스크탑 화면(설정 mobileUi 로 강제 가능).
 * 조작은 **입력 장치**가 정한다: 모바일 앱(폰·태블릿)은 터치라 드래그·우클릭이 없으므로,
 * 데스크탑 화면을 그리고 있어도 탭은 액션시트(TaskSheetModal)로 간다. 안 그러면 태블릿은
 * 화면은 넓은데 task 를 여는 것 말고는 고칠 방법이 없다.
 */
import { Platform } from "obsidian";

/** 탭 = 액션시트인가. 모바일 화면이면 언제나, 데스크탑 화면이면 모바일 앱(태블릿)일 때만. */
export function tapOpensSheet(mobileUi: boolean): boolean {
  if (mobileUi) return true;
  try {
    return !!Platform.isMobile;
  } catch (e) {
    return false;
  }
}
