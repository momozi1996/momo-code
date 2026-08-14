# v1.0.0 Release Checklist

Pre-tag:
- [~] `npm run build` succeeds locally (Mac arm64 + Linux x64)
  - ✅ Windows x64 build verified 2026-08-10 (`tsc && fix-esm`, 108 files)
  - ❌ Mac arm64 / Linux x64 still unverified
- [ ] `bash install --no-modify-path` succeeds on a clean VM
- [x] `momo --version` prints 1.0.0 — verified 2026-08-10
- [x] `momo /evolve --demo` prints `Tactics: 2` (or more) — verified 2026-08-10
- [x] `momo /fine-tune` prints health report without errors — verified 2026-08-10
- [ ] `momo /fine-tune run --auto` produces `~/.momo/finetune/runs/run_*/run.json` with `ratchetPassed: true`
- [~] All links in README.md actually resolve — audited & fixed 2026-08-10
  - Fixed: simple-icons huggingface v10→v12; removed nonexistent web/translate/favicon
    icons (→ shields.io badges); filled `##WEBSITE_URL##`/`##HF_URL##` placeholders in
    README_zh; `momocode.cc` → `momozi.cc` (install cmd + `$schema` refs); fixed
    中文 badge (img src pointed at a markdown page)
  - ❌ `@momo/cli` not published on npm yet (registry 404) — badge/link dead until publish
  - ❌ `momozi.cc/config.json` 404 (`$schema` target not deployed, website-side)
  - ⚠️ `huggingface.co/momozi` unreachable from audit network (blocked, not verified)
- [x] `curl -sI https://momozi.cc/install` returns 200 — verified 2026-08-10

Tag + Release:
- [x] git tag v1.0.0 && git push --tags
- [ ] Build prebuilt binaries (optional for v1) and upload to release assets
- [ ] Update website's hero install command (if changed)
