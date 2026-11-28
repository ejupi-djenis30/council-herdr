#!/usr/bin/env bash
set -uo pipefail
root="$RUNNER_TEMP/cou7-linux"
evidence="$RUNNER_TEMP/cou7-evidence"
mkdir -p "$root" "$evidence" "$root/home" "$root/bin" "$root/project" "$root/runtime"
chmod 700 "$root/runtime"
export HOME="$root/home" XDG_CONFIG_HOME="$root/home/config" XDG_STATE_HOME="$root/home/state"
export XDG_DATA_HOME="$root/home/data" XDG_CACHE_HOME="$root/home/cache" XDG_RUNTIME_DIR="$root/runtime"
export HERDR_APP_HOME="$root/home/config/herdr-app" HC_SESSION="cou7-linux-${GITHUB_RUN_ID}"
export COU7_EVIDENCE="$evidence" COU7_PROJECT="$root/project" COU7_EVENTS="$root/events.jsonl"
export COU7_NODE="$(command -v node)" COU7_FIXTURE="$GITHUB_WORKSPACE/harness/.github/cou7-linux/participant.mjs"
export PATH="$root/bin:$PATH" LIBGL_ALWAYS_SOFTWARE=1
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json
unset HC_SOCKET HC_TERMINAL_ID NODE_OPTIONS
facts="$evidence/facts.txt"
say() { printf '%s\n' "$*" | tee -a "$facts"; }
fail() { say "BLOCKED: $*"; exit 1; }
say "harness_sha=$GITHUB_SHA"
say "council_sha=$(git -C "$GITHUB_WORKSPACE/council" rev-parse HEAD)"
say "council_tree=$(git -C "$GITHUB_WORKSPACE/council" rev-parse 'HEAD^{tree}')"
say "runner_image=${ImageOS:-unknown} ${ImageVersion:-unknown} arch=$(uname -m) node=$(node --version)"
[[ "$(git -C "$GITHUB_WORKSPACE/council" rev-parse HEAD)" == e8974841558641faaa9aecab7386fa7001928137 ]] || fail 'Council revision mismatch'
[[ "$(git -C "$GITHUB_WORKSPACE/council" rev-parse 'HEAD^{tree}')" == d4bc8cc3a97555686c4c16f07e9a07486216b942 ]] || fail 'Council tree mismatch'
say 'interface=runner; prerequisites=display, DBus, software Vulkan'
say "display=${DISPLAY:-absent} dbus_present=$([[ -n ${DBUS_SESSION_BUS_ADDRESS:-} ]] && echo yes || echo no)"
xdpyinfo >/dev/null 2>&1 && say 'display_check=pass' || say 'display_check=fail'
dbus-send --session --dest=org.freedesktop.DBus --type=method_call /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1 && say 'dbus_check=pass' || say 'dbus_check=fail'
if vulkaninfo --summary >"$root/vulkan.txt" 2>&1; then
  grep -E 'deviceName|driverName|driverInfo' "$root/vulkan.txt" | head -8 >>"$facts" || true
  grep -qiE 'llvmpipe|lavapipe' "$root/vulkan.txt" && say 'software_vulkan=pass' || say 'software_vulkan=not_confirmed'
else say 'software_vulkan=unavailable'; fi
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
"$COU7_APP" check "$HERDR_APP_HOME/mods/council" >"$root/mod-check.txt" 2>&1 && say 'installed_mod_check=pass' || { say 'installed_mod_check=fail'; tail -8 "$root/mod-check.txt" >>"$facts"; }
say 'interface=Core; start isolated test session'
hc server start >"$root/core-start.json" 2>"$root/core-start-error.txt" && say 'core_start=pass' || { say 'core_start=fail'; tail -5 "$root/core-start-error.txt" >>"$facts"; }
hc server status >"$evidence/core-status.json" 2>"$root/core-status-error.txt" && say 'core_status=pass' || say 'core_status=fail'
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
say 'interface=Desktop; launch isolated app and open native Workspace'
"$COU7_APP" >"$root/desktop.log" 2>&1 & app_pid=$!
ui=blocked
if timeout 35 xdotool search --sync --onlyvisible --pid "$app_pid" >"$root/window-id.txt" 2>/dev/null; then
  say 'desktop_window=visible'
  "$COU7_APP" status >"$root/desktop-status.txt" 2>&1 && say 'desktop_status=pass' || say 'desktop_status=fail'
  if "$COU7_APP" do space.new --name 'COU7 test' --folder "$COU7_PROJECT" --argv '["/bin/sh","-c","printf COU7_SPACE"]' >"$root/space.json" 2>"$root/space-error.txt"; then
    say 'interface=Desktop_command space_new=pass'
    if "$COU7_APP" do mod.open --name council >"$root/open.json" 2>"$root/open-error.txt"; then
      say 'interface=Desktop_command mod_open=pass'
      if python3 "$GITHUB_WORKSPACE/harness/.github/cou7-linux/ui.py" >"$root/ui-out.txt" 2>"$root/ui-error.txt"; then ui=created_and_delegated; else ui=failed; fi
      cat "$root/ui-out.txt" >>"$facts"; cat "$root/ui-error.txt" >>"$facts"
    else say 'UI_FIRST_FAILURE=Desktop command mod.open'; tail -5 "$root/open-error.txt" >>"$facts"; fi
  else say 'UI_FIRST_FAILURE=Desktop command space.new'; tail -5 "$root/space-error.txt" >>"$facts"; fi
else
  say 'UI_FIRST_FAILURE=no visible Desktop window within bounded startup'
  tail -8 "$root/desktop.log" | sed "s|$root|<isolated>|g" >>"$facts"
fi
say "ui_gate=$ui"
if [[ "$ui" == created_and_delegated ]]; then
  (cd "$COU7_PROJECT" && node "$COU7_CLI" work-item list >"$root/ui-list.json" 2>"$root/ui-list-error.txt") || true
  item=$(node -e 'try {const x=require(process.argv[1]);const a=x.items.filter(i=>i.title==="Linux native checkpoint");if(a.length===1)console.log(a[0].id)}catch{}' "$root/ui-list.json")
  say "ui_item=${item:-not_observed}"
  hc ls --all --json >"$root/ui-terminals.json" 2>/dev/null || true
  worker=$(node -e 'try {const x=require(process.argv[1]);const t=x.terminals.find(t=>t.name?.startsWith("c-job-"));if(t)console.log(t.address)}catch{}' "$root/ui-terminals.json")
  if [[ -n "$worker" ]]; then
    say "ui_worker_address=$worker"; hc wait --json "$worker" --timeout 90 >"$evidence/ui-worker-wait.json" 2>/dev/null || true
  else say 'ui_worker_address=not_observed'; fi
  if [[ -n "$item" ]]; then
    (cd "$COU7_PROJECT" && node "$COU7_CLI" work-item show --id "$item" >"$root/ui-show.json" 2>"$root/ui-show-error.txt") || true
    node - "$root/ui-show.json" "$COU7_EVENTS" >>"$facts" <<'NODE'
const fs=require('fs');try {const x=JSON.parse(fs.readFileSync(process.argv[2]));const i=x.item||{};console.log(JSON.stringify({interface:'installed_CLI_inspection',id:i.id,state:i.state,job:i.job,resultPresent:!!i.result,nextAction:i.nextAction,resultText:i.result?.output}));}catch{console.log('ui_show=unavailable')}
try {const e=fs.readFileSync(process.argv[3],'utf8').trim().split('\n').map(JSON.parse);console.log(JSON.stringify({fixtureEvents:e.map(x=>x.event),assignments:e.filter(x=>x.event==='assignment').length,address:e[0]?.address}));}catch{console.log('fixture_events=unavailable')}
NODE
  fi
  if "$COU7_APP" do mod.open --name council >/dev/null 2>&1 && "$COU7_APP" do mod.open --name council >/dev/null 2>&1; then
    if python3 "$GITHUB_WORKSPACE/harness/.github/cou7-linux/ui.py" reopen >"$root/ui-reopen-out.txt" 2>"$root/ui-reopen-error.txt"; then
      say 'ui_reopen_handoff_and_delegation=observed'
    else say 'ui_reopen_handoff_and_delegation=failed'; fi
    cat "$root/ui-reopen-out.txt" >>"$facts"; cat "$root/ui-reopen-error.txt" >>"$facts"
  else say 'ui_reopen=Desktop command failed'; fi
elif [[ ! -e "$COU7_EVENTS" ]] && ! grep -qE 'UI_FIRST_FAILURE=(save|delegate|actor|confirm|delegated)' "$root/ui-error.txt" 2>/dev/null; then
  say 'interface=installed_CLI; fallback uses a separate synthetic work item, not the UI gate'
  printf '%s\n' '{"id":"wi-linux-cli-fallback","title":"Linux native checkpoint","roleId":"verifier","criteria":["Name the first heading.","Give a concrete next action."]}' >"$root/input.json"
  (cd "$COU7_PROJECT" && node "$COU7_CLI" work-item create --input-file "$root/input.json" >"$root/create.json" 2>"$root/create-error.txt") && say 'cli_create=pass' || say 'cli_create=fail'
  (cd "$COU7_PROJECT" && node "$COU7_CLI" work-item delegate --id wi-linux-cli-fallback --timeout 75 >"$root/delegate.json" 2>"$root/delegate-error.txt") && say 'cli_delegate=accepted' || say 'cli_delegate=failed'
  hc ls --all --json >"$root/terminals.json" 2>/dev/null || true
  worker=$(node -e 'try {const x=require(process.argv[1]);const t=x.terminals.find(t=>t.name?.startsWith("c-job-"));if(t)console.log(t.address)}catch{}' "$root/terminals.json")
  if [[ -n "$worker" ]]; then
    say "worker_address=$worker"; hc wait --json "$worker" --timeout 90 >"$evidence/worker-wait.json" 2>/dev/null || true
  else say 'worker_address=not_observed'; fi
  (cd "$COU7_PROJECT" && node "$COU7_CLI" work-item show --id wi-linux-cli-fallback >"$root/show.json" 2>"$root/show-error.txt") || true
  node - "$root/show.json" "$COU7_EVENTS" >>"$facts" <<'NODE'
const fs=require('fs');try { const x=JSON.parse(fs.readFileSync(process.argv[2])); const i=x.item||{}; console.log(JSON.stringify({interface:'installed_CLI',id:i.id,state:i.state,job:i.job,resultPresent:!!i.result,nextAction:i.nextAction})); } catch { console.log('cli_show=unavailable') }
try { const e=fs.readFileSync(process.argv[3],'utf8').trim().split('\n').map(JSON.parse); console.log(JSON.stringify({fixtureEvents:e.map(x=>x.event),assignments:e.filter(x=>x.event==='assignment').length,address:e[0]?.address})); } catch { console.log('fixture_events=unavailable') }
NODE
fi
say 'interface=checkout; normal npm test outside Herdr terminal'
(cd "$GITHUB_WORKSPACE/council" && npm test >"$root/npm-test.txt" 2>&1); test_exit=$?
say "npm_test_exit=$test_exit"; tail -9 "$root/npm-test.txt" >>"$facts"
say 'cleanup: only finished owned terminals may be removed; live terminals are left to disposable runner teardown'
hc ls --all --json >"$root/last-terminals.json" 2>/dev/null || true
node - "$root/last-terminals.json" >>"$facts" <<'NODE'
try { const x=require(process.argv[2]); console.log(JSON.stringify({remainingTerminals:x.terminals?.map(t=>({address:t.address,state:t.state,name:t.name,exit_code:t.exit_code}))})); } catch {}
NODE
say 'ui_gate_status=inspect all UI, delivery, result and exit evidence before declaring pass'
