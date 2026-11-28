#!/usr/bin/env bash
set -uo pipefail
root="$RUNNER_TEMP/cou7-macos"
evidence="$RUNNER_TEMP/cou7-macos-evidence"
harness="$GITHUB_WORKSPACE/harness"
council="$GITHUB_WORKSPACE/council"
mkdir -p "$root/home" "$root/bin" "$root/project" "$evidence"
export HOME="$root/home" XDG_CONFIG_HOME="$root/home/config" XDG_STATE_HOME="$root/home/state"
export XDG_DATA_HOME="$root/home/data" XDG_CACHE_HOME="$root/home/cache"
export HERDR_APP_HOME="$root/home/config/herdr-app" HC_SESSION="cou7-macos-${GITHUB_RUN_ID}"
export DO_NOT_TRACK=1 HERDR_TELEMETRY=0 PATH="$root/bin:$PATH"
unset HC_SOCKET HC_TERMINAL_ID NODE_OPTIONS
facts="$evidence/facts.txt"
input='not_run'; ui='not_run'; core='not_run'; cli='not_run'; package='not_run'; first='none'; app_pid=''
say() { printf '%s\n' "$*" | tee -a "$facts"; }
run() {
  label="$1"; limit="$2"; shift 2
  python3 "$harness/.github/cou7-macos/bounded.py" "$limit" "$root/$label.out" "$root/$label.err" "$@"
  code=$?; say "$label.exit=$code"; return "$code"
}
fatal() { first="$1"; say "first_failure=$first"; exit 1; }
summary() {
  say "verdict.session_input=$input"
  say "verdict.ui=$ui"
  say "verdict.core=$core"
  say "verdict.installed_cli=$cli"
  say "verdict.package=$package"
  say "verdict.first_failure=$first"
  say 'verdict.technical_job_is_not_the_UI_gate=true'
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { printf '## COU-7 macOS arm64\n\n'; printf '**Session/input: %s**\n\n**UI: %s**\n\n' "$input" "$ui";
      printf '**Core: %s; installed CLI: %s; package: %s**\n\n' "$core" "$cli" "$package";
      printf 'First unresolved step: %s. Technical job status is separate from the UI gate.\n' "$first"; } >> "$GITHUB_STEP_SUMMARY"
  fi
}
trap summary EXIT
say "harness_sha=$GITHUB_SHA"
say "council_sha=$(git -C "$council" rev-parse HEAD)"
say "council_tree=$(git -C "$council" rev-parse 'HEAD^{tree}')"
say "runner_image=${ImageOS:-unknown} image_version=${ImageVersion:-unknown} os=$(sw_vers -productVersion) build=$(sw_vers -buildVersion) machine=$(uname -m)"
say "node_version=$(node --version) node_arch=$(node -p 'process.arch')"
say "hardware_arm64=$(sysctl -n hw.optional.arm64 2>/dev/null || printf unavailable)"
say "launcher_translation=$(sysctl -n sysctl.proc_translated 2>/dev/null || printf unavailable)"
[ "$(git -C "$council" rev-parse HEAD)" = e8974841558641faaa9aecab7386fa7001928137 ] || fatal council_revision_mismatch
[ "$(git -C "$council" rev-parse 'HEAD^{tree}')" = d4bc8cc3a97555686c4c16f07e9a07486216b942 ] || fatal council_tree_mismatch
[ "$(uname -m)" = arm64 ] && [ "$(node -p 'process.arch')" = arm64 ] || fatal runner_architecture_mismatch

appurl=https://releases.herdr.dev/app/0.1.18/herdr-app-macos-aarch64.tar.gz
coreurl=https://releases.herdr.dev/core/0.1.22/herdr-core-macos-aarch64.tar.gz
say "desktop_url=$appurl"
say 'desktop_expected_sha256=fd646b4a6db2c3e9b4700be7d10153440cb799c960b082d4ab60a5fd63f9372a'
say "core_url=$coreurl"
say 'core_expected_sha256=90798daadefa8d126b90ef0bcdbe9c7dda9c6cfbf011a247065ab5da348f350e'
run desktop_download 100 curl -fsSL --max-time 90 "$appurl" -o "$root/desktop.tar.gz" || fatal desktop_download_failed
run core_download 100 curl -fsSL --max-time 90 "$coreurl" -o "$root/core.tar.gz" || fatal core_download_failed
apphash=$(shasum -a 256 "$root/desktop.tar.gz" | cut -d' ' -f1)
corehash=$(shasum -a 256 "$root/core.tar.gz" | cut -d' ' -f1)
say "desktop_actual_sha256=$apphash"; say "core_actual_sha256=$corehash"
[ "$apphash" = fd646b4a6db2c3e9b4700be7d10153440cb799c960b082d4ab60a5fd63f9372a ] || fatal desktop_digest_mismatch
[ "$corehash" = 90798daadefa8d126b90ef0bcdbe9c7dda9c6cfbf011a247065ab5da348f350e ] || fatal core_digest_mismatch
tar -xzf "$root/desktop.tar.gz" -C "$root" || fatal desktop_extract_failed
tar -xzf "$root/core.tar.gz" -C "$root/bin" || fatal core_extract_failed
ln -s herdr-core "$root/bin/hc"
app="$root/Herdr.app/Contents/MacOS/Herdr"; hc="$root/bin/hc"; corebinary="$root/bin/herdr-core"; nodebin=$(command -v node)
[ -x "$app" ] && [ -x "$hc" ] || fatal extracted_binary_missing
say "desktop_binary_arch=$(lipo -archs "$app" 2>/dev/null || printf unknown)"
say "core_binary_arch=$(lipo -archs "$corebinary" 2>/dev/null || printf unknown)"
run desktop_version 20 "$app" --version || fatal desktop_version_failed
run core_version 20 "$hc" --version || fatal core_version_failed
say "desktop_version=$(head -1 "$root/desktop_version.out")"
say "core_version=$(head -1 "$root/core_version.out")"
run desktop_skill 20 "$app" --skill || fatal desktop_skill_failed
run core_skill 20 "$hc" --skill || fatal core_skill_failed
appskill=$(shasum -a 256 "$root/desktop_skill.out" | cut -d' ' -f1)
coreskill=$(shasum -a 256 "$root/core_skill.out" | cut -d' ' -f1)
say "desktop_skill_sha256=$appskill"; say "core_skill_sha256=$coreskill"
[ "$appskill" = f6ff7b9cbf94dce5bea0e36c4d145ec15044bba968c9d669f756e97edf996b54 ] || fatal unreviewed_desktop_skill
[ "$coreskill" = d3d7734519aa83e6c16cc89a2b25130910b1263fd054e1a099f9caf8e150afec ] || fatal unreviewed_core_skill

if run compile_native_probe 100 swiftc -o "$root/native-probe" "$harness/.github/cou7-macos/native-probe.swift"; then
  if run native_probe 15 "$root/native-probe"; then
    cat "$root/native_probe.out" >> "$facts"
    input=$(node -e 'const fs=require("fs");try{const a=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);const x=a.find(x=>x.stage==="native_input");console.log(x?.pass?"pass":x?.firstFailure||"incomplete")}catch{console.log("probe_output_invalid")}' "$root/native_probe.out")
  else input="native_probe_exit_$code"; cat "$root/native_probe.out" >> "$facts" 2>/dev/null || true; fi
else
  input="native_probe_compile_failed"
  grep -i 'error:' "$root/compile_native_probe.err" | head -8 | sed -E 's@/[^ :]+@<path>@g' >> "$facts" || true
fi
if ! run compile_arch_probe 30 clang -Wall -Wextra -o "$root/arch-probe" "$harness/.github/cou7-macos/arch-probe.c"; then say 'process_architecture_probe=unavailable'; fi

(cd "$council" && npm pack --pack-destination "$root" >"$root/pack-name.txt" 2>"$root/pack-error.txt") || fatal npm_pack_failed
tarball="$root/$(tail -1 "$root/pack-name.txt")"
say "npm_tarball_sha256=$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
run package_smoke 90 "$nodebin" "$council/.github/scripts/package-smoke.mjs" "$tarball" || fatal package_smoke_failed
run npm_install 100 npm install --prefix "$root/install" --ignore-scripts --no-audit --no-fund "$tarball" || fatal npm_install_failed
pkg="$root/install/node_modules/council-herdr"
run installed_help 30 "$nodebin" "$pkg/bin/council.js" --help || fatal installed_help_failed
run mod_install 40 "$nodebin" "$pkg/herdr/install.js" --app-home "$HERDR_APP_HOME" || fatal mod_install_failed
[ -f "$HERDR_APP_HOME/mods/council/.council-install.json" ] || fatal mod_receipt_missing
cli_bin="$HERDR_APP_HOME/mods/council/engine/bin/council.js"
run installed_doctor 40 "$nodebin" "$cli_bin" doctor || fatal installed_doctor_failed
if run installed_mod_check 45 "$app" check "$HERDR_APP_HOME/mods/council"; then package=pass; else package=mod_check_failed; fi
if (cd "$root/project" && run installed_work_item_list 30 "$nodebin" "$cli_bin" work-item list); then cli=pass_readonly; else cli=readback_failed; fi

if (cd "$root" && run core_start 45 "$hc" server start) && run core_status 20 "$hc" server status; then
  node - "$root/core_status.out" >> "$facts" <<'NODE'
try{const s=JSON.parse(require('fs').readFileSync(process.argv[2]));console.log(JSON.stringify({stage:'core_status',version:s.version,live:s.live,finished:s.finished}))}catch{console.log('core_status_parse=failed')}
NODE
  printf '%s\n' 'console.log("COU7_MAC_CORE_TRANSPORT_OK")' > "$root/core-probe.cjs"
  if run core_run 35 "$hc" run --bg --json --name cou7-mac-core-probe --cwd "$root/project" -- "$nodebin" "$root/core-probe.cjs"; then
    address=$(node -e 'try{const x=JSON.parse(require("fs").readFileSync(process.argv[1]));if(/^t[0-9a-z]+$/.test(x.address))console.log(x.address)}catch{}' "$root/core_run.out")
    if [ -n "$address" ] && run core_wait 40 "$hc" wait --json "$address" --timeout 30 && run core_read 20 "$hc" read --lines 5 "$address"; then
      node - "$root/core_wait.out" "$root/core_read.out" >> "$facts" <<'NODE'
const fs=require('fs');try{const w=JSON.parse(fs.readFileSync(process.argv[2]));const mark=fs.readFileSync(process.argv[3],'utf8').includes('COU7_MAC_CORE_TRANSPORT_OK');console.log(JSON.stringify({stage:'core_transport',address:w.address??w.terminal,ended:w.ended,reason:w.reason,exitCode:w.exit_code,markerObserved:mark,pass:w.ended===true&&w.reason==='exit'&&w.exit_code===0&&mark}))}catch{console.log('core_transport_parse=failed')}
NODE
      if node - "$root/core_wait.out" "$root/core_read.out" <<'NODE'
const fs=require('fs');try{const w=JSON.parse(fs.readFileSync(process.argv[2]));process.exit(w.ended===true&&w.reason==='exit'&&w.exit_code===0&&fs.readFileSync(process.argv[3],'utf8').includes('COU7_MAC_CORE_TRANSPORT_OK')?0:1)}catch{process.exit(1)}
NODE
      then core=pass_controlled_transport; run core_remove_finished 20 "$hc" rm "$address" || true; else core=transport_incomplete; fi
    else core=wait_or_read_failed; fi
  else core=launch_failed; fi
else core=start_or_status_failed; fi

if [ -x "$root/arch-probe" ]; then
  found=0
  for pid in $(pgrep -f "$root/bin/(hc|herdr-core)" || true); do
    if "$root/arch-probe" "$corebinary" "$pid" >> "$root/core-architectures.jsonl" 2>/dev/null; then found=$((found+1)); fi
  done
  say "owned_core_architecture_processes=$found"
  [ ! -f "$root/core-architectures.jsonl" ] || { say 'core_architectures_begin'; cat "$root/core-architectures.jsonl" >> "$facts"; say 'core_architectures_end'; }
fi

"$app" > "$root/desktop.out" 2> "$root/desktop.err" & app_pid=$!
say 'desktop_launch=isolated_owned_process'
if (cd "$council" && run npm_test 240 npm test); then say 'npm_test=pass'; else say 'npm_test=failed'; fi
grep -E '^[[:space:]]*[ℹ#]?[[:space:]]*(tests|pass|fail|skipped)[[:space:]]+[0-9]+' "$root/npm_test.out" | tail -8 >> "$facts" || true
if kill -0 "$app_pid" 2>/dev/null; then
  say 'desktop_process=live'
  if [ -x "$root/arch-probe" ]; then "$root/arch-probe" "$app" "$app_pid" >> "$facts" 2>/dev/null || say 'desktop_process_architecture=unavailable'; fi
  run desktop_status 20 "$app" status || true
  if [ -x "$root/native-probe" ]; then
    run desktop_window_inspection 15 "$root/native-probe" inspect "$app_pid" || true
    cat "$root/desktop_window_inspection.out" >> "$facts" 2>/dev/null || true
  fi
else
  wait "$app_pid"; app_exit=$?; say "desktop_process=exited code=$app_exit"
  python3 - "$root/desktop.err" >> "$facts" <<'PY'
import os,re,sys
try:
    lines=open(sys.argv[1],errors='replace').read().splitlines()
    for line in [x for x in lines if re.search(r'error|failed|panic|fatal|windowserver|display',x,re.I)][:4]:
        line=re.sub(r'(?:/[A-Za-z0-9_.-]+)+','<path>',line)
        line=re.sub(r'\b(?:\d{1,3}\.){3}\d{1,3}\b','<ip>',line)
        user=os.environ.get('USER','')
        if user: line=line.replace(user,'<user>')
        print('desktop_error='+line[:300])
except OSError: pass
PY
fi

if [ "$input" = pass ]; then
  ui=not_run_requires_native_UI_harness
  first=native_UI_harness_required
else
  ui=blocked_before_any_UI_mutation
  first="$input"
fi
say 'ui_mutations=none'
say 'cli_fallback=not_run'
say 'cleanup=only_finished_owned_probe_removed_remaining_isolated_processes_to_runner_teardown'
if [ -n "$app_pid" ] && kill -0 "$app_pid" 2>/dev/null; then kill "$app_pid" 2>/dev/null || true; fi
exit 0
