import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

// 개발 중 스크래치 볼트로 바로 뽑고 싶으면 GCAL_OUT=<볼트>/.obsidian/plugins/gcal-calendar-view/main.js
// ⛔ 실제 볼트의 .obsidian/plugins 는 BRAT 이 관리한다 — 거기로 뽑지 말 것.
const outfile = process.env.GCAL_OUT || "main.js";

const banner = `/* gcal-calendar-view - generated bundle. Do not edit directly — 원본은 src/ 다. */`;

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile,
  minify: prod,
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
