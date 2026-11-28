#!/usr/bin/env bash
set -uo pipefail
root="$RUNNER_TEMP/cou7-linux"
evidence="$RUNNER_TEMP/cou7-evidence"
mkdir -p "$root" "$evidence" "$root/home" "$root/bin" "$root/project" "$root/runtime" "$root/raw-shots"
chmod 700 "$root/runtime"
export HOME="$root/home" XDG_CONFIG_HOME="$root/home/config" XDG_STATE_HOME="$root/home/state"
export XDG_DATA_HOME="$root/home/data" XDG_CACHE_HOME="$root/home/cache" XDG_RUNTIME_DIR="$root/runtime"
export HERDR_APP_HOME="$root/home/config/herdr-app" HC_SESSION="cou7-linux-${GITHUB_RUN_ID}"
export COU7_EVIDENCE="$evidence" COU7_PROJECT="$root/project" COU7_EVENTS="$root/events.jsonl"
export COU7_RAW_SHOTS="$root/raw-shots" COU7_SCRATCH="$root"
export COU7_NODE="$(command -v node)" COU7_FIXTURE="$GITHUB_WORKSPACE/harness/.github/cou7-linux/participant.mjs"
export COU7_READY_FIFO="$root/participant-ready.fifo" COU7_RELEASE_FIFO="$root/participant-release.fifo"
mkfifo "$COU7_READY_FIFO" "$COU7_RELEASE_FIFO"
export PATH="$root/bin:$PATH" LIBGL_ALWAYS_SOFTWARE=1 XDG_SESSION_TYPE=x11
unset HC_SOCKET HC_TERMINAL_ID NODE_OPTIONS
facts="$evidence/facts.txt"
say() { printf '%s\n' "$*" | tee -a "$facts"; }
fail() { say "BLOCKED: $*"; exit 1; }
finalize() {
  if ! grep -q '"overall_gate":' "$facts" 2>/dev/null; then printf '%s\n' '{"overall_gate":"blocked_by_setup_or_harness"}' >>"$facts"; fi
  local verdict milestone
  verdict=$(node -e 'const f=require("fs").readFileSync(process.argv[1],"utf8").split("\n");for(const l of f){try{const x=JSON.parse(l);if(x.overall_gate){console.log(x.overall_gate);break}}catch{}}' "$facts" 2>/dev/null)
  milestone=$(grep '^UI_REACHED=' "$facts" | tail -1 | cut -d= -f2- || true)
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    { printf '## COU-7 Linux native gate\n\n'; printf '**UI gate: %s**\n\n' "${verdict:-unknown}";
      printf 'Last observed UI milestone: %s. The technical job exit and CLI fallback are separate from the UI gate.\n' "${milestone:-none}"; } >>"$GITHUB_STEP_SUMMARY"
  fi
}
trap finalize EXIT
cp "$GITHUB_WORKSPACE/harness/.github/cou7-linux/calibration.json" "$evidence/offline-calibration.json"
say "harness_sha=$GITHUB_SHA"
say "council_sha=$(git -C "$GITHUB_WORKSPACE/council" rev-parse HEAD)"
say "council_tree=$(git -C "$GITHUB_WORKSPACE/council" rev-parse 'HEAD^{tree}')"
say "runner_image=${ImageOS:-unknown} ${ImageVersion:-unknown} arch=$(uname -m) node=$(node --version)"
say "tesseract_version=$(tesseract --version 2>/dev/null | head -1)"
say "same_image_version_as_first=$([[ ${ImageVersion:-} == 20261122.23.1 ]] && echo yes || echo no)"
[[ "$(git -C "$GITHUB_WORKSPACE/council" rev-parse HEAD)" == e8974841558641faaa9aecab7386fa7001928137 ]] || fail 'Council revision mismatch'
[[ "$(git -C "$GITHUB_WORKSPACE/council" rev-parse 'HEAD^{tree}')" == d4bc8cc3a97555686c4c16f07e9a07486216b942 ]] || fail 'Council tree mismatch'
say 'interface=runner; prerequisites=display, DBus, software Vulkan'
say "display=${DISPLAY:-absent} dbus_present=$([[ -n ${DBUS_SESSION_BUS_ADDRESS:-} ]] && echo yes || echo no)"
say "xdg_session_type=$XDG_SESSION_TYPE xdg_runtime_exists=$([[ -d $XDG_RUNTIME_DIR ]] && echo yes || echo no) writable=$([[ -w $XDG_RUNTIME_DIR ]] && echo yes || echo no) mode=$(stat -c %a "$XDG_RUNTIME_DIR")"
dpkg-query -W -f='${Package} ${Version}\n' mesa-vulkan-drivers libxkbcommon-x11-0 libvulkan1 vulkan-tools >>"$facts" 2>/dev/null || true
old_icd=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json
say "previous_lavapipe_basename=$(basename "$old_icd") present=$([[ -f $old_icd ]] && echo yes || echo no)"
if [[ -f "$old_icd" ]]; then
  VK_ICD_FILENAMES="$old_icd" vulkaninfo --summary >"$root/vulkan-old.txt" 2>&1; say "previous_lavapipe_vulkaninfo_exit=$?"
else say 'previous_lavapipe_vulkaninfo=not_run_manifest_absent'; fi
icd=$(dpkg -L mesa-vulkan-drivers | grep -E '/lvp_icd[^/]*\.json$' | head -1 || true)
if [[ -n "$icd" && -f "$icd" ]]; then export VK_ICD_FILENAMES="$icd"; say "lavapipe_manifest=$(basename "$icd")"; else say 'lavapipe_manifest=not_found'; fi
xdpyinfo >/dev/null 2>&1 && say 'display_check=pass' || say 'display_check=fail'
dbus-send --session --dest=org.freedesktop.DBus --type=method_call /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1 && say 'dbus_check=pass' || say 'dbus_check=fail'
vulkaninfo --summary >"$root/vulkan.txt" 2>&1; vulkan_exit=$?
say "vulkaninfo_exit=$vulkan_exit"
if [[ "$vulkan_exit" -eq 0 ]]; then
  grep -E 'deviceName|driverName|driverInfo|Vulkan Instance Version' "$root/vulkan.txt" | head -8 >>"$facts" || true
  grep -qiE 'llvmpipe|lavapipe' "$root/vulkan.txt" && say 'software_vulkan=pass' || say 'software_vulkan=not_confirmed'
else
  say 'software_vulkan=unavailable'
  grep -iE 'error|fail|warn|cannot|unable|not found|permission' "$root/vulkan.txt" | head -12 | sed -E 's@/[^ ]+@<path>@g;s@([0-9]{1,3}\.){3}[0-9]{1,3}@<ip>@g' >>"$facts" || true
fi
appurl=https://releases.herdr.dev/app/0.1.18/herdr-app-linux-x86_64.tar.gz
coreurl=https://releases.herdr.dev/core/0.1.22/herdr-core-linux-x86_64.tar.gz
say "desktop_url=$appurl expected_sha256=8a11edd79dd40b349f7286cf51910b62e21136daf8f03005a9fd2c4dc5830f83"
say "core_url=$coreurl expected_sha256=3054ec3992ce80c5715d721caa9dcefa6056721d15dc113f4750afce763ba5df"
curl -fsSL --max-time 90 "$appurl" -o "$root/app.tar.gz" || fail 'Desktop download'
curl -fsSL --max-time 90 "$coreurl" -o "$root/core.tar.gz" || fail 'Core download'
apphash=$(sha256sum "$root/app.tar.gz" | cut -d' ' -f1); corehash=$(sha256sum "$root/core.tar.gz" | cut -d' ' -f1)
say "desktop_actual_sha256=$apphash"; say "core_actual_sha256=$corehash"
[[ "$apphash" == 8a11edd79dd40b349f7286cf51910b62e21136daf8f03005a9fd2c4dc5830f83 ]] || fail 'Desktop digest mismatch'
[[ "$corehash" == 3054ec3992ce80c5715d721caa9dcefa6056721d15dc113f4750afce763ba5df ]] || fail 'Core digest mismatch'
tar -xzf "$root/app.tar.gz" -C "$root" || fail 'Desktop archive extraction'
tar -xzf "$root/core.tar.gz" -C "$root/bin" || fail 'Core archive extraction'
ln -s herdr-core "$root/bin/hc"
export COU7_APP="$root/herdr-app/herdr-app"
say "desktop_version=$($COU7_APP --version 2>&1 | head -1)"
say "core_version=$(hc --version 2>&1 | head -1)"
hc --skill >"$root/hc-skill.txt" || fail 'hc skill'
curl -fsSL --max-time 20 https://raw.githubusercontent.com/herdrdev/herdr-core/v0.1.22/crates/herdr-core/src/SKILL.md -o "$root/hc-skill-source.txt" || fail 'hc skill source'
cmp -s "$root/hc-skill.txt" "$root/hc-skill-source.txt" && say 'hc_skill_matches_reviewed_tag=yes' || say 'hc_skill_matches_reviewed_tag=no'
say 'interface=package; npm pack from pinned checkout'
(cd "$GITHUB_WORKSPACE/council" && npm pack --pack-destination "$root" >"$root/pack-name.txt" 2>"$root/pack-stderr.txt") || fail 'npm pack'
tarball="$root/$(tail -1 "$root/pack-name.txt")"
say "npm_tarball_sha256=$(sha256sum "$tarball" | cut -d' ' -f1)"
node "$GITHUB_WORKSPACE/council/.github/scripts/package-smoke.mjs" "$tarball" >"$root/package-smoke.txt" 2>&1 && say 'package_smoke=pass' || say 'package_smoke=fail'
npm install --prefix "$root/install" --ignore-scripts --no-audit --no-fund "$tarball" >"$root/install.log" 2>&1 || fail 'package install'
pkg="$root/install/node_modules/council-herdr"
export COU7_CLI="$pkg/bin/council.js"
node "$COU7_CLI" --help >"$root/cli-help.txt" 2>&1 && say 'installed_cli_help=pass' || say 'installed_cli_help=fail'
node "$pkg/herdr/install.js" --app-home "$HERDR_APP_HOME" >"$root/mod-install.txt" 2>&1 || fail 'mod install'
test -f "$HERDR_APP_HOME/mods/council/.council-install.json" && say 'mod_receipt=present' || fail 'mod receipt missing'
export COU7_CLI="$HERDR_APP_HOME/mods/council/engine/bin/council.js"
node "$COU7_CLI" doctor >"$root/doctor.txt" 2>&1 && say 'installed_doctor=pass' || say 'installed_doctor=fail'
"$COU7_APP" check "$HERDR_APP_HOME/mods/council" >"$root/mod-check.txt" 2>&1 && say 'installed_mod_check=pass' || { say 'installed_mod_check=fail'; tail -8 "$root/mod-check.txt" | sed -E "s|$root|<isolated>|g;s@([0-9]{1,3}\\.){3}[0-9]{1,3}@<ip>@g" >>"$facts"; }
say 'interface=Core; start isolated test session'
hc server start >"$root/core-start.json" 2>"$root/core-start-error.txt" && say 'core_start=pass' || { say 'core_start=fail'; tail -5 "$root/core-start-error.txt" | sed -E "s|$root|<isolated>|g;s@([0-9]{1,3}\\.){3}[0-9]{1,3}@<ip>@g" >>"$facts"; }
if hc server status >"$root/core-status.json" 2>"$root/core-status-error.txt"; then
  node - "$root/core-status.json" >"$evidence/core-status.json" <<'NODE'
const s=require(process.argv[2]);console.log(JSON.stringify({version:s.version,live:s.live,finished:s.finished}));
NODE
  say 'core_status=pass'
else say 'core_status=fail'; fi
hc run --bg --json --name cou7-core-probe --cwd "$COU7_PROJECT" -- /bin/sh -c 'printf "COU7 CORE TRANSPORT OK\n"' >"$root/core-run.json" 2>"$root/core-run-error.txt"
if [[ -s "$root/core-run.json" ]]; then
  hc wait --json cou7-core-probe --timeout 20 >"$evidence/core-wait.json" 2>/dev/null || true
  hc read --lines 5 cou7-core-probe >"$root/core-screen.txt" 2>/dev/null || true
  grep -q 'COU7 CORE TRANSPORT OK' "$root/core-screen.txt" && say 'core_terminal_transport=pass' || say 'core_terminal_transport=fail'
  node -e 'const f=require(process.argv[1]);process.exit(f.ended&&f.reason==="exit"&&f.exit_code===0?0:1)' "$evidence/core-wait.json" 2>/dev/null && hc rm cou7-core-probe >/dev/null 2>&1 || true
else say 'core_terminal_transport=unavailable'; fi
printf '# Linux Native Checkpoint\n' >"$COU7_PROJECT/README.md"
cat >"$root/bin/junie" <<'EOF'
#!/bin/sh
exec "$COU7_NODE" "$COU7_FIXTURE" "$@"
EOF
chmod +x "$root/bin/junie"
(cd "$COU7_PROJECT" && node "$COU7_CLI" team set verifier --agent junie --role 'Linux fixture' --permission read >"$root/team.json" 2>&1) && say 'interface=installed_CLI team_fixture=created' || say 'interface=installed_CLI team_fixture=failed'
collect_delivery() {
  local item="$1" label="$2" participant worker pid alive
  if ! timeout 60 head -n 1 "$COU7_READY_FIFO" >"$root/participant-address.txt"; then
    say "${label}_participant_ready=not_observed"
    hc ls --all --json >"$root/$label-unconfirmed-terminals.json" 2>/dev/null || true
    worker=$(node -e 'try{const x=require(process.argv[1]);const a=x.terminals.filter(t=>t.name?.startsWith("c-job-")&&t.state==="live");if(a.length===1)console.log(a[0].address)}catch{}' "$root/$label-unconfirmed-terminals.json")
    if [[ -n "$worker" ]]; then
      say "${label}_unconfirmed_worker=$worker"
      hc wait --json "$worker" --timeout 140 >"$evidence/$label-unconfirmed-worker-wait.json" 2>/dev/null || true
    fi
    return 1
  fi
  participant=$(cat "$root/participant-address.txt")
  [[ "$participant" =~ ^t[0-9a-z]+$ ]] || { say "${label}_participant_address=invalid"; return 1; }
  hc ls --all --json >"$root/$label-terminals.json" 2>/dev/null || true
  worker=$(node -e 'try {const x=require(process.argv[1]);const a=x.terminals.filter(t=>t.name?.startsWith("c-job-"));if(a.length===1)console.log(a[0].address)}catch{}' "$root/$label-terminals.json")
  say "${label}_participant=$participant worker=${worker:-not_observed}"
  hc get --json "$participant" >"$root/$label-participant-before.json" 2>"$root/$label-participant-before-error.txt" || true
  [[ -n "$worker" ]] && hc get --json "$worker" >"$root/$label-worker-before.json" 2>/dev/null || true
  pid=$(node -e 'try {const x=require(process.argv[1]);if(Number.isInteger(x.pid))console.log(x.pid)}catch{}' "$root/$label-participant-before.json")
  hc wait --json "$participant" --timeout 80 >"$root/$label-participant-wait.json" 2>"$root/$label-participant-wait-error.txt" & participant_wait=$!
  if [[ -n "$worker" ]]; then hc wait --json "$worker" --timeout 80 >"$root/$label-worker-wait.json" 2>"$root/$label-worker-wait-error.txt" & worker_wait=$!; else worker_wait=''; fi
  timeout 10 sh -c 'printf "release\\n" > "$1"' sh "$COU7_RELEASE_FIFO" || say "${label}_release=failed"
  wait "$participant_wait" || true
  [[ -n "$worker_wait" ]] && wait "$worker_wait" || true
  hc get --json "$participant" >"$root/$label-participant-after.json" 2>"$root/$label-participant-after-error.txt" || true
  alive=unknown; if [[ "$pid" =~ ^[0-9]+$ ]]; then if kill -0 "$pid" 2>/dev/null; then alive=yes; else alive=no; fi; fi
  say "${label}_participant_pid_alive_after_worker=$alive"
  (cd "$COU7_PROJECT" && node "$COU7_CLI" work-item show --id "$item" >"$root/$label-show.json" 2>"$root/$label-show-error.txt") || true
  session=$(node -e 'try{const i=require(process.argv[1]).item;if(i.job?.sessionId)console.log(i.job.sessionId)}catch{}' "$root/$label-show.json")
  if [[ "$session" =~ ^wi-job-[a-z0-9-]+$ ]]; then
    (cd "$COU7_PROJECT" && node "$COU7_CLI" status --session "$session" >"$root/$label-job-status.json" 2>"$root/$label-job-status-error.txt") || true
    (cd "$COU7_PROJECT" && node "$COU7_CLI" result --session "$session" >"$root/$label-job-result.json" 2>"$root/$label-job-result-error.txt") || true
  fi
  node - "$root" "$label" "$COU7_EVENTS" "$alive" >>"$facts" <<'NODE'
const fs=require('fs'), path=require('path');const [root,label,events,alive]=process.argv.slice(2);
const read=n=>{try{return JSON.parse(fs.readFileSync(path.join(root,`${label}-${n}.json`)))}catch{return null}};
const before=read('participant-before'), after=read('participant-after'), p=read('participant-wait'), w=read('worker-wait'), wb=read('worker-before'), show=read('show'), status=read('job-status'), result=read('job-result');
const i=show?.item||{}, o=i.result?.output||'';
let e=[];try{e=fs.readFileSync(events,'utf8').trim().split('\n').map(JSON.parse)}catch{}
const slim=t=>t&&({address:t.address??t.terminal,state:t.state,turn:t.turn,status:t.status,ended:t.ended,reason:t.reason,exit_code:t.exit_code});
console.log(JSON.stringify({label,interface:'Core_and_installed_CLI',participantBefore:slim(before),participantWait:slim(p),participantAfter:slim(after),workerBefore:slim(wb),workerWait:slim(w),participantPidAlive:alive,
  item:{id:i.id,title:i.title,criteria:i.criteria,roleId:i.roleId,revision:i.lifecycle?.revision,workRevision:i.lifecycle?.workRevision,state:i.state,job:i.job,nextAction:i.nextAction,
  expectedHeading:o.includes('Heading: # Linux Native Checkpoint'),expectedNext:o.includes('Next action: compare the heading with the saved criteria.')},
  jobReadback:status&&{sessionId:status.sessionId,state:status.state,deliveryState:status.deliveryState,participantAddress:status.participant?.address,power:status.participant?.power,workerAddress:status.worker?.address},
  jobResult:result&&{sessionId:result.sessionId,state:result.state,turn:result.turn,ready:result.ready,captureScope:result.captureScope},
  fixtureEvents:e.map(x=>x.event),assignments:e.filter(x=>x.event==='assignment').length}));
NODE
}
observe_overlay() {
  local label="$1" expected="$2"
  python3 "$GITHUB_WORKSPACE/harness/.github/cou7-linux/ui.py" overlay "$label" "$expected" >>"$facts" 2>>"$facts"
}
say 'interface=Desktop; launch isolated app and open native Workspace'
"$COU7_APP" >"$root/desktop.log" 2>&1 & app_pid=$!
export COU7_APP_PID="$app_pid"
ui=blocked
if timeout 35 xdotool search --sync --onlyvisible --pid "$app_pid" >"$root/window-id.txt" 2>/dev/null; then
  say 'desktop_window=visible'
  export COU7_WINDOW_ID="$(head -1 "$root/window-id.txt")"
  "$COU7_APP" status >"$root/desktop-status.txt" 2>&1 && say 'desktop_status=pass' || say 'desktop_status=fail'
  if "$COU7_APP" do space.new --name 'COU7 test' --folder "$COU7_PROJECT" --argv '["/bin/sh","-c","printf COU7_SPACE"]' >"$root/space.json" 2>"$root/space-error.txt"; then
    say 'interface=Desktop_command space_new=pass'
    project_terminal=$(node -e 'try{const x=require(process.argv[1]);if(typeof x.terminal==="string")console.log(x.terminal)}catch{}' "$root/space.json")
    say "project_terminal=${project_terminal:-not_observed}"
    if "$COU7_APP" do mod.open --name council >"$root/open.json" 2>"$root/open-error.txt"; then
      say 'interface=Desktop_command mod_open=pass'
      if python3 "$GITHUB_WORKSPACE/harness/.github/cou7-linux/ui.py" >"$root/ui-out.txt" 2>"$root/ui-error.txt"; then ui=created_and_delegated; else ui=failed; fi
      cat "$root/ui-out.txt" >>"$facts"; cat "$root/ui-error.txt" >>"$facts"
    else say 'UI_FIRST_FAILURE=Desktop command mod.open'; tail -5 "$root/open-error.txt" | sed -E "s|$root|<isolated>|g;s@([0-9]{1,3}\\.){3}[0-9]{1,3}@<ip>@g" >>"$facts"; fi
  else say 'UI_FIRST_FAILURE=Desktop command space.new'; tail -5 "$root/space-error.txt" | sed -E "s|$root|<isolated>|g;s@([0-9]{1,3}\\.){3}[0-9]{1,3}@<ip>@g" >>"$facts"; fi
else
  say 'UI_FIRST_FAILURE=no visible Desktop window within bounded startup'
  grep -iE 'panicked|error|failed|cannot|needs |fatal' "$root/desktop.log" | head -8 | sed -E "s|$root|<isolated>|g;s@([0-9]{1,3}\\.){3}[0-9]{1,3}@<ip>@g" >>"$facts" || true
fi
say "ui_gate=$ui"
if [[ "$ui" == created_and_delegated ]]; then
  item=$(node -e 'try{const x=require(process.argv[1]);if(x.id)console.log(x.id)}catch{}' "$root/ui-created.json")
  say "ui_item=${item:-not_observed}"
  [[ -n "$item" ]] && collect_delivery "$item" ui || say 'ui_delivery_evidence=incomplete'
  if observe_overlay before-close present && "$COU7_APP" do mod.open --name council >/dev/null 2>&1 && observe_overlay closed absent && "$COU7_APP" do mod.open --name council >/dev/null 2>&1 && observe_overlay reopened present; then
    say 'ui_overlay_close_and_reopen=observed'
    if python3 "$GITHUB_WORKSPACE/harness/.github/cou7-linux/ui.py" reopen >"$root/ui-reopen-out.txt" 2>"$root/ui-reopen-error.txt"; then
      say 'ui_reopen_handoff_and_delegation=observed'
    else say 'ui_reopen_handoff_and_delegation=failed'; fi
    cat "$root/ui-reopen-out.txt" >>"$facts"; cat "$root/ui-reopen-error.txt" >>"$facts"
  else say 'ui_reopen=Desktop command failed'; fi
elif [[ -e "$root/ui-delegate-attempted" ]]; then
  say 'ui_delegation_outcome=uncertain_no_resend'
  item=$(node -e 'try{const x=require(process.argv[1]);if(x.id)console.log(x.id)}catch{}' "$root/ui-created.json")
  [[ -n "$item" ]] && collect_delivery "$item" ui_uncertain || say 'ui_uncertain_delivery_evidence=incomplete'
elif [[ -e "$root/ui-save-attempted" ]]; then
  say 'ui_save_outcome=uncertain_no_resend'
  (cd "$COU7_PROJECT" && node "$COU7_CLI" work-item list >"$root/ui-uncertain-list.json" 2>/dev/null) || true
  node - "$root/ui-uncertain-list.json" >>"$facts" <<'NODE'
try{const x=require(process.argv[2]);console.log(JSON.stringify({interface:'installed_CLI_readonly_after_uncertain_UI',items:x.items?.map(i=>({id:i.id,title:i.title,roleId:i.roleId,state:i.state}))}));}catch{console.log('uncertain_save_readback=unavailable')}
NODE
elif [[ ! -e "$COU7_EVENTS" ]]; then
  say 'interface=installed_CLI; fallback uses a separate synthetic work item, not the UI gate'
  printf '%s\n' '{"id":"wi-linux-cli-fallback","title":"Linux native checkpoint","roleId":"verifier","criteria":["Name the first heading.","Give a concrete next action."]}' >"$root/input.json"
  (cd "$COU7_PROJECT" && node "$COU7_CLI" work-item create --input-file "$root/input.json" >"$root/create.json" 2>"$root/create-error.txt") && say 'cli_create=pass' || say 'cli_create=fail'
  if (cd "$COU7_PROJECT" && node "$COU7_CLI" work-item delegate --id wi-linux-cli-fallback --timeout 120 >"$root/delegate.json" 2>"$root/delegate-error.txt"); then
    say 'cli_delegate=accepted'; collect_delivery wi-linux-cli-fallback fallback || say 'fallback_delivery_evidence=incomplete'
  else say 'cli_delegate=failed'; fi
fi
say 'interface=checkout; normal npm test outside Herdr terminal'
(cd "$GITHUB_WORKSPACE/council" && npm test >"$root/npm-test.txt" 2>&1); test_exit=$?
say "npm_test_exit=$test_exit"; tail -9 "$root/npm-test.txt" >>"$facts"
say 'cleanup: only finished owned terminals may be removed; live terminals are left to disposable runner teardown'
hc ls --all --json >"$root/last-terminals.json" 2>/dev/null || true
node - "$root/last-terminals.json" "$root/space.json" "$COU7_EVENTS" >>"$facts" <<'NODE'
try {
  const fs=require('fs'),x=require(process.argv[2]);let project,participant;
  try{project=require(process.argv[3]).terminal}catch{}
  try{participant=JSON.parse(fs.readFileSync(process.argv[4],'utf8').split('\n')[0]).address}catch{}
  console.log(JSON.stringify({remainingTerminals:x.terminals?.map(t=>({address:t.address,state:t.state,
    kind:t.address===project?'project':t.address===participant?'fixture':'other',exit_code:t.exit_code}))}));
} catch {}
NODE
node - "$facts" >>"$facts" <<'NODE'
const fs=require('fs');const lines=fs.readFileSync(process.argv[2],'utf8').split('\n');let ui,created;
for(const line of lines){try{const v=JSON.parse(line);if(v.label==='ui')ui=v}catch{};if(line.startsWith('UI_ITEM_READBACK=')){try{created=JSON.parse(line.slice('UI_ITEM_READBACK='.length))}catch{}}}
const i=ui?.item||{}, worker=ui?.workerWait||{}, participant=ui?.participantWait||{};
const checks={prerequisites:['display_check=pass','dbus_check=pass','software_vulkan=pass','package_smoke=pass','mod_receipt=present','installed_doctor=pass','installed_mod_check=pass','core_status=pass','core_terminal_transport=pass','desktop_window=visible','npm_test_exit=0'].every(v=>lines.includes(v)),
  createdAndDelegated:lines.includes('ui_gate=created_and_delegated'),overlayCloseAndReopen:lines.includes('ui_overlay_close_and_reopen=observed'),
  reopenedHandoffAndDelegation:lines.includes('ui_reopen_handoff_and_delegation=observed'),
  definition:i.id===created?.id&&i.title==='Linux native checkpoint'&&i.roleId==='verifier'&&JSON.stringify(i.criteria)===JSON.stringify(['Name the first heading.','Give a concrete next action.'])&&Number.isInteger(created?.revision)&&Number.isInteger(i.revision)&&i.revision>=created.revision,
  job:i.state==='result_ready'&&i.job?.linked===true&&i.job?.deliveryState==='acknowledged'&&i.job?.outcome==='completed'&&i.job?.address===ui?.participantBefore?.address&&i.job?.sessionId===ui?.jobReadback?.sessionId&&ui?.jobResult?.sessionId===i.job?.sessionId&&ui?.jobResult?.ready===true&&ui?.jobReadback?.workerAddress===ui?.workerBefore?.address&&ui?.jobReadback?.participantAddress===i.job?.address,
  result:i.expectedHeading===true&&i.expectedNext===true&&i.nextAction==='Review the handoff against the acceptance criteria.',
  once:ui?.assignments===1&&ui?.fixtureEvents?.includes('result')&&!ui?.fixtureEvents?.includes('error'),
  core:worker.ended===true&&worker.reason==='exit'&&worker.exit_code===0&&participant.ended===true&&ui?.participantBefore?.status?.state==='working'&&Number.isInteger(ui?.participantBefore?.turn)&&participant.turn>ui.participantBefore.turn&&ui?.jobResult?.turn===participant.turn&&ui?.participantPidAlive==='no'&&ui?.jobReadback?.power==='off'};
console.log(JSON.stringify({overall_gate:Object.values(checks).every(Boolean)?'pass':'incomplete_or_blocked',checks}));
NODE
