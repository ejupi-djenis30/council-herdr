import { View, div } from 'gpui-kit';
import { Button, h_flex, v_flex, InputState } from 'gpui-base';
import { agents, appHome, checking, closeOverlay, exec, focused, hc, notify, panes, props, readTextFile, run, spaces, terminals, theme } from 'herdr';
import { brandMark, button, cardHeading, columns, field, glyph, iconTile, input, label, panel, progress, reviewStatus, sectionTab, statusPill } from './components.js';
import { countLabel, decisionSummary, discussionType, invitation, pollStatus, projectLabels, projectName } from './poll-text.js';
import { pollParticipants, pollResults } from './poll-view.js';
import { delegationStatus, delegationView } from './delegation-view.js';
import { agentName, ballotBody, discussionView } from './discussion-view.js';
import { launcher, menu, sections } from './navigation.js';
import { submitTask, taskFormDefaults, taskFormValues } from './task-launch.js';
import { refreshFormalTally, startFormalRound } from './round-actions.js';
import { newSchedule, renderSchedules, changeSchedule } from './schedule-view.js';
import { hostId, desktopId, focusedProject, participantTerminal, executeEngine, peerEngine, invitationWorkerArgs } from './machine-engine.js';
import { taskEditor, teamEditor, teamView } from './team-view.js';
import { workspaceView } from './workspace-view.js';
import { folderKey, WorkItems, workItemScopeKey, workItemScreenVisible } from './work-item-actions.js';
import { makeLifecycleFields, makeWorkItemFields } from './work-item-view.js';

const modes = [
  ['choice', 'Options'],
  ['mixed', 'Options + free'],
  ['open', 'Free response']
];

const samplePlan = `# Project plan

## Parser {#parser}
files: [src/parser/**]
- [~] Verify input recovery {#parser-recovery}
  by: qa

## Rollout {#rollout}
kind: human
needs: [parser]
- [ ] Review the rollout checklist {#rollout-checklist}

## decisions
- Record a decision and its evidence here.
`;

function localSpace() {
  return spaces().find(space => space.active);
}

function localProjects(active, allSpaces) {
  const localSpaces = allSpaces ? spaces().filter(space => space.machine === active.machine) : [active];
  const tabs = new Set(localSpaces.flatMap(space => space.tabs.map(tab => tab.id)));
  const ids = new Set(localSpaces.map(space => space.id));
  const folders = [...localSpaces.map(space => space.folder),
    ...panes().filter(pane => hostId(pane.terminal, active.machine) && tabs.has(pane.tab)).map(pane => pane.cwd),
    ...terminals().filter(terminal => hostId(terminal.address, active.machine) &&
      ids.has(desktopId(terminal.labels?.['herdr.space'], active.machine))).map(terminal => terminal.cwd)];
  const seen = new Set();
  return folders.filter(folder => {
    if (!folder || seen.has(folderKey(folder))) return false;
    seen.add(folderKey(folder));
    return true;
  });
}

function activityProjects(space, focus) {
  const paths = localProjects(space, false);
  const folder = focusedProject(focus, space);
  if (folder && !paths.some(path => folderKey(path) === folderKey(folder))) {
    paths.push(folder);
  }
  return paths;
}

function spaceRecipients(space) {
  const byAddress = new Map(terminals().map(terminal => [terminal.address, terminal]));
  const folders = new Map(panes().map(pane => [pane.terminal, pane.cwd]));
  return agents().filter(agent => agent.space === space?.id).map(agent => {
    const terminal = byAddress.get(agent.address);
    return {
      address: hostId(agent.address, space.machine), label: agent.program?.name ?? agent.address, createdAt: terminal?.created_ms,
      folder: terminal?.cwd || folders.get(agent.address) || space.folder, status: agent.status
    };
  }).filter(person => person.address);
}

const recipientStatuses = { idle: 'Idle', working: 'Working', blocked: 'Needs input', done: 'Done', error: 'Error' };

function recipientKey({ address, createdAt }) {
  return `${address}:${createdAt}`;
}

function eligibleRecipient(recipient) {
  return Number.isSafeInteger(recipient.createdAt) && recipient.createdAt > 0;
}

const inviteStates = {
  queued: 'Waiting for terminal', sending: 'Sending invitation', uncertain: 'Delivery uncertain · Check terminal',
  alignment_required: 'Waiting for Council alignment', not_aligned: 'Council skill or integration missing',
  needs_reload: 'Reload Council in this agent terminal',
  unavailable: 'Terminal unavailable', expired: 'Delivery window elapsed', cancelled: 'Invitation cancelled',
  dispatch_failed: 'Invitation worker stopped before sending'
};

function needsSetup(person) {
  return ['alignment_required', 'not_aligned', 'needs_reload'].some(state => state === person.state || state === person.reason);
}

function deliveryView(t, delivery, { canAct, disabled, check, retry }) {
  if (!delivery?.targets.length) return null;
  const sent = delivery.targets.filter(person => person.state === 'sent').length;
  const expired = delivery.targets.some(person => person.state === 'expired');
  const when = new Date(delivery.expiresAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  const pending = delivery.targets.filter(person => person.state !== 'sent');
  const section = v_flex().gap(6).pt(8).border_t_1().border_color(t.border)
    .child(h_flex().gap(6).items_center().justify_between().flex_wrap()
      .child(label(`Invitations · ${sent}/${delivery.targets.length} sent`, 12, t.foreground).font_semibold())
      .when(pending.some(needsSetup), row => row.child(button(t, 'invitation-setup-guide', 'Setup guide', (_e, cx) =>
        cx.open_url('https://github.com/Ejupi-Labs/council-herdr/blob/main/docs/alignment.md')))));
  if (delivery.active || expired) section.child(label(delivery.active ? `Delivery ends ${when}` : `Delivery window ended ${when}`, 11, t.muted));
  if (delivery.claimed && !delivery.active && pending.some(person => person.state === 'expired')) {
    section.child(label('An invitation worker still holds the delivery. Check its terminal before retrying.', 11, t.muted));
  }
  return section.children(pending.map(person => {
    const last = !delivery.active && person.reason && person.reason !== 'queued' ? inviteStates[person.reason] : null;
    const state = [inviteStates[person.state] ?? person.state, last].filter(Boolean).join(' · ');
    return h_flex().gap(6).items_center().justify_between().flex_wrap()
      .child(v_flex().min_w_0().gap(2)
        .child(label(`${person.label ?? person.address} (${person.address})`, 12, t.foreground))
        .child(label(person.state === 'uncertain' ? `${state}. Check the terminal before sending again.` : state, 11, t.muted)))
      .child(h_flex().gap(5).flex_wrap()
        .when(canAct && needsSetup(person) && Number.isSafeInteger(person.createdAt), row =>
          row.child(button(t, `check-${person.address}`, 'Check setup', (_e, cx) => check(cx, person.address), 'normal', disabled)))
        .when(canAct && person.retryable, row =>
          row.child(button(t, `retry-${person.address}`, 'Retry invite', (_e, cx) => retry(cx, person.address), 'normal', disabled))));
  }));
}

export default class Council extends View {
  init(_props, cx) {
    const options = props();
    this.role = options?.role;
    if (this.role === 'launcher') {
      this.compact = false;
      return;
    }
    if (this.role === 'menu') {
      this.menuIndex = 0;
      this.menuFocus = cx.focus_handle();
      this.menuFocus.focus();
      return;
    }
    this.tab = sections.find(section => section.id === options?.initialTab)?.id ?? 'activity';
    this.pollSection = 'results';
    this.listFilter = 'all';
    this.wide = false;
    this.wideNavigation = false;
    this.folder = null;
    this.spaceId = null;
    this.spaceMachine = null;
    this.recovering = false;
    this.allSpaces = false;
    this.selected = null;
    this.form = null;
    this.config = null;
    this.engine = null;
    this.peerEngines = new Map();
    this.configError = '';
    this.data = null;
    this.epoch = 0;
    this.error = '';
    this.readError = '';
    this.loading = false;
    this.saving = false;
    this.checkingInvitation = false;
    this.panelFocus = cx.focus_handle();
    this.backFocus = cx.focus_handle();
    this.newFocus = cx.focus_handle();
    this.workspace = { view: 'runs', group: 'all', component: null, limit: 9, pinned: null, diagnostics: false };
    this.workItems = new WorkItems({
      runCli: (project, args, engine) => this.runCli(project, args, engine),
      readTeam: (project, engine) => this.request(project, 'team', {}, engine),
      visible: screen => this.workItemVisible(screen),
      lifecycle: true
    });
    this.lifecycleFocus = {
      tab: cx.focus_handle(), queue: cx.focus_handle(), back: cx.focus_handle(), refresh: cx.focus_handle(), formBack: cx.focus_handle(),
      allRoles: cx.focus_handle(), attention: cx.focus_handle(), clearFilters: cx.focus_handle(),
      states: Object.fromEntries(['', 'open', 'in_review', 'closed'].map(state => [state, cx.focus_handle()])),
      delegate: cx.focus_handle(), copyOutput: cx.focus_handle(), openDelegation: cx.focus_handle(),
      confirm: cx.focus_handle(), history: cx.focus_handle(), archive: cx.focus_handle(), output: cx.focus_handle()
    };
    this.lifecycleFields = null;
    this.pendingWorkItemReturn = null;
    this.workItemForm = null;
    this.activityTarget = null;
    this.discoveredProjects = [];
    this.activityFollows = null;
    this.lastFocusedProject = null;
    this.workspaceReturn = null;
    this.trail = [];
    this.listProject = null;

    if (checking()) return;
    // The native multiline Input context otherwise uses Tab for indentation.
    cx.bind_keys([
      { keystroke: 'tab', action: 'council-work-item-next-field', context: 'CouncilWorkItemCriteria > Input' },
      { keystroke: 'shift-tab', action: 'council-work-item-previous-field', context: 'CouncilWorkItemCriteria > Input' }
    ]);
    this.panelFocus.focus();
    this.search = InputState.new({ placeholder: 'Search by title, project or ID' });
    this.search.on('change', (_e, cx) => cx.notify());
    this.activitySearch = InputState.new({ placeholder: 'Search…' });
    this.activitySearch.on('change', (_e, cx) => cx.notify());
    this.reply = InputState.new({ placeholder: 'Write a reply…' });
    this.reply.on('change', (_e, cx) => cx.notify());
    this.reply.on('submit', (_e, cx) => this.postReply(cx));
    cx.spawn(async cx => {
      try {
        const root = `${appHome()}/mods/council`;
        const raw = await readTextFile(`${root}/config.json`);
        const config = JSON.parse(raw ?? '{}');
        if (!config || (config.node !== undefined && (typeof config.node !== 'string' || !config.node.trim()))) {
          throw new Error('Council config.json needs a Node.js executable path.');
        }
        this.config = { machine: null, node: config.node ?? 'node', entry: `${root}/runtime/council.mjs`,
          cli: config.cli || `${root}/engine/bin/council.js` };
        this.refresh(cx);
        this.resumeInvitations(cx);
        cx.timer.every(5000, cx => this.refresh(cx));
        cx.timer.every(10000, cx => this.resumeInvitations(cx));
      } catch (error) {
        this.configError = error.message;
        cx.notify();
      }
    });
  }

  clearForm() {
    if (!this.form) return;
    for (const input of this.form.inputs) input.release();
    this.form = null;
  }

  setForm(kind, fields = {}, extra = {}) {
    this.clearForm();
    this.error = '';
    const states = Object.fromEntries(Object.entries(fields)
      .map(([name, value]) => [name, InputState.new({ value })]));
    this.form = { kind, ...extra, ...states, inputs: Object.values(states) };
    this.form.inputs[0]?.focus();
  }

  cancelForm(cx) {
    this.clearForm();
    this.error = '';
    if (this.selected) this.backFocus?.focus();
    else this.newFocus?.focus();
    cx.notify();
  }

  currentSpace(space = localSpace()) {
    return Boolean(this.engine && space?.folder && space.id === this.spaceId && space.folder === this.folder &&
      (space.machine ?? null) === this.engine.machine);
  }

  async engineFor(machine) {
    if (!machine) return this.config;
    if (!this.peerEngines.has(machine)) this.peerEngines.set(machine, peerEngine(machine, exec, readTextFile));
    try { return await this.peerEngines.get(machine); }
    catch (error) { this.peerEngines.delete(machine); throw error; }
  }

  async request(folder, action, payload = {}, engine = this.engine) {
    let result;
    try {
      result = await executeEngine(exec, engine, 'entry', ['desktop', action, JSON.stringify(payload)], folder, 10000);
    } catch (error) {
      if (engine?.machine) this.peerEngines.delete(engine.machine);
      throw new Error(`Council could not start its Node.js helper. ${error.message}`);
    }
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Council could not complete the request.');
    return JSON.parse(result.stdout);
  }

  async runCli(project, args, engine = this.engine) {
    const installed = await readTextFile(engine.cli, { on: engine.machine });
    if (!installed) throw new Error('Install the Council Desktop engine on the project machine, or set cli in its Council config.json to the absolute path of bin/council.js.');
    return executeEngine(exec, engine, 'cli', args, project, 30000);
  }

  navigate(cx, tab, selection = null, { returnTo = null, listProject = null, trail = [] } = {}) {
    const returningToList = this.tab === tab && this.selected && !selection;
    if (tab !== this.tab) this.clearFilters();
    this.leaveWorkItems();
    if (tab !== 'activity') this.pendingWorkItemReturn = null;
    this.pollSection = 'results';
    this.epoch++;
    this.loading = false;
    this.saving = false;
    this.selected = selection;
    this.workspaceReturn = returnTo;
    this.trail = trail;
    this.listProject = listProject;
    this.tab = tab;
    this.data = null;
    this.error = '';
    this.readError = '';
    this.clearForm();
    this.reply?.set_value('');
    if (selection) this.backFocus?.focus();
    if (returningToList) this.search?.focus();
    this.refresh(cx);
    cx.notify();
  }

  workspaceBookmark() {
    return { ...this.workspace, target: this.activityTarget, search: this.activitySearch.value() };
  }

  workItemTarget(space) {
    return this.workspace.pinned || focusedProject(focused(), space) || this.lastFocusedProject || space?.folder;
  }

  workItemVisible(screen) {
    const space = localSpace();
    return workItemScreenVisible(screen, {
      space, target: this.workItemTarget(space),
      workspaceActive: this.tab === 'activity' && this.workspace.view === 'work-items' && this.currentSpace(space)
    });
  }

  syncWorkItemFields() {
    const form = this.workItems.current?.form;
    if (this.lifecycleFields?.form !== form) {
      if (this.lifecycleFields) for (const state of Object.values(this.lifecycleFields.fields)) state.release();
      this.lifecycleFields = null;
      if (form) {
        const entry = { form, fields: makeLifecycleFields(form), activeField: null };
        this.lifecycleFields = entry;
        for (const [key, state] of Object.entries(entry.fields)) {
          state.on('focus', (_e, cx) => {
            entry.activeField = key;
            cx.notify();
          });
          state.on('blur', (_e, cx) => {
            if (entry.activeField === key) entry.activeField = null;
            cx.notify();
          });
        }
      }
    }
    const screen = this.workItems.current;
    if (this.workItemForm?.screen === screen) return;
    if (this.workItemForm) {
      this.workItemForm.fields.title.release();
      this.workItemForm.fields.criteria.release();
      this.workItemForm = null;
    }
    if (screen?.kind === 'create') this.workItemForm = { screen, fields: makeWorkItemFields() };
  }

  leaveWorkItems() {
    this.workItems.leave();
    this.syncWorkItemFields();
  }

  runWorkItemAction(cx, action, { preserveFocus = false, onStart } = {}) {
    cx.spawn(async cx => {
      const previous = this.workItems.current;
      const hadRoles = Boolean(previous?.roles?.length);
      const task = action();
      const screen = this.workItems.current;
      this.syncWorkItemFields();
      const transition = screen?.kind === 'create' ? this.workItems.createAttempt(screen) :
        screen?.kind === 'detail' ? this.workItems.mutation(screen) : null;
      const redirect = preserveFocus && task && screen && this.workItemVisible(screen) &&
        (screen !== previous || screen.pending || ['writing', 'checking'].includes(transition?.phase));
      if (redirect) (screen.kind === 'list' ? this.lifecycleFocus.queue : this.lifecycleFocus.back).focus();
      onStart?.();
      cx.notify();
      await task;
      this.syncWorkItemFields();
      if (redirect && screen.kind === 'create' && (screen !== previous || !hadRoles) &&
          this.workItems.isCurrent(screen) && screen.roles?.length &&
          !this.workItems.createAttempt(screen) && this.lifecycleFocus.back.is_focused()) {
        this.workItemForm?.fields.title.focus();
      }
      cx.notify();
    });
  }

  syncWorkItems(cx, space = localSpace()) {
    const workItems = this.workItems;
    if (this.tab !== 'activity' || this.workspace.view !== 'work-items' || !this.data?.project || !this.currentSpace(space)) return;
    const scope = Object.freeze({
      space: space.id, project: this.data.project, engine: Object.freeze({ ...this.engine }), anchor: this.activityTarget
    });
    if (workItems.current && workItemScopeKey(workItems.current.scope) === workItemScopeKey(scope)) return;
    this.runWorkItemAction(cx, () => {
      if (!this.workItemVisible({ kind: 'list', scope }) ||
          (workItems.current && workItemScopeKey(workItems.current.scope) === workItemScopeKey(scope))) return;
      const restore = this.pendingWorkItemReturn;
      this.pendingWorkItemReturn = null;
      if (restore?.space === scope.space && restore.machine === scope.engine.machine &&
          folderKey(restore.project) === folderKey(scope.project)) {
        this.lifecycleFocus.back.focus();
        return workItems.restore(scope, restore.id, restore.archive);
      }
      return workItems.showList(scope);
    });
  }

  backToWorkItems(cx, screen) {
    if (!this.workItems.isCurrent(screen)) return;
    if (folderKey(this.workItemTarget(localSpace())) === folderKey(screen.scope.anchor)) {
      this.runWorkItemAction(cx, () => this.workItems.isCurrent(screen) && this.workItems.showList(screen.scope),
        { preserveFocus: true });
      return;
    }
    this.leaveWorkItems();
    this.lifecycleFocus.queue.focus();
    this.workspace.pinned = screen.scope.project;
    this.refresh(cx);
    this.syncWorkItems(cx);
    cx.notify();
  }

  openWorkItemSection(cx, screen, tab, selection = null) {
    if (!this.workItems.isCurrent(screen)) return;
    const { project } = screen.scope;
    const bookmark = { ...this.workspaceBookmark(), target: project };
    if (screen.kind === 'detail') Object.assign(bookmark, {
      workItem: { id: screen.id, archive: screen.archived?.id, project, space: screen.scope.space, machine: screen.scope.engine.machine }
    });
    this.navigate(cx, tab, selection, { returnTo: bookmark, listProject: selection ? null : project });
  }

  workItemViewProps() {
    const workItems = this.workItems;
    const screen = workItems.current;
    const fields = this.workItemForm?.screen === screen ? this.workItemForm?.fields : null;
    if (!screen || !this.workItemVisible(screen)) return { screen: null };
    const focus = this.lifecycleFocus;
    const perform = (cx, action, { preserveFocus = false, onStart } = {}) => {
      let started = false;
      this.runWorkItemAction(cx, () => {
        if (!workItems.isCurrent(screen)) return;
        started = true;
        return action();
      }, { preserveFocus, onStart: onStart && (() => {
        if (started && workItems.current && this.workItemVisible(workItems.current)) onStart();
      }) });
    };
    const lifecycle = this.lifecycleFields?.form === screen.form ? this.lifecycleFields : null;
    const mutation = screen.kind === 'detail' ? workItems.mutation(screen) : null;
    const review = screen.archived ? screen.archived.review : screen.item?.lifecycle?.review;
    const formalLink = workItems.formalLink(screen);
    const archiveExecution = screen.archived?.review?.capture.verified
      ? workItems.sessionLink(screen, 'delegations', screen.archived.review.capture.sessionId) : null;
    const openLink = (cx, link) => {
      if (link) this.openWorkItemSection(cx, screen, link.tab, { id: link.id, project: link.project });
    };
    const closeArchive = cx => {
      if (!workItems.isCurrent(screen)) return;
      screen.archived = null;
      (screen.history ? focus.history : focus.back).focus();
      cx.notify();
    };
    return {
      screen, fields, focus, mutation, formalLink, archiveExecution, wide: this.wide,
      formFields: lifecycle?.fields, activeField: lifecycle?.activeField,
      attempt: screen.kind === 'create' ? workItems.createAttempt(screen) : null,
      actions: {
        refresh: (_e, cx) => perform(cx, () => workItems.refresh(screen), { preserveFocus: true }),
        create: (_e, cx) => perform(cx, () => workItems.startCreate(screen), { preserveFocus: true }),
        open: (cx, id) => perform(cx, () => workItems.open(screen, id), { preserveFocus: true }),
        filter: (cx, filters) => perform(cx, () => workItems.filter(screen, filters), { preserveFocus: true }),
        role: (cx, id) => {
          if (!workItems.isCurrent(screen) || workItems.createAttempt(screen)) return;
          screen.roleId = id;
          cx.notify();
        },
        save: (_e, cx) => perform(cx, () => workItems.save(screen,
          fields && { title: fields.title.value(), criteria: fields.criteria.value() }), { preserveFocus: true }),
        discard: (_e, cx) => perform(cx, () => workItems.discardCreate(screen), { preserveFocus: true }),
        back: (_e, cx) => this.backToWorkItems(cx, screen),
        team: (_e, cx) => this.openWorkItemSection(cx, screen, 'team'),
        delegation: (_e, cx) => openLink(cx, workItems.delegationLink(screen)),
        mutate: (cx, operation) => perform(cx, () => workItems.startMutation(screen, operation), { onStart: () => {
          if (this.lifecycleFields?.form === screen.form) this.lifecycleFields?.fields.actor.focus();
        } }),
        confirm: (_e, cx) => perform(cx, () => lifecycle && workItems.confirmMutation(screen,
          Object.fromEntries(Object.entries(lifecycle.fields).map(([key, state]) => [key, state.value()]))), { preserveFocus: true }),
        cancelForm: (_e, cx) => perform(cx, () => workItems.cancelMutation(screen), { onStart: () => focus.back.focus() }),
        formOption: (cx, key, value) => {
          workItems.selectMutation(screen, key, value);
          cx.notify();
        },
        refreshOptions: (_e, cx) => perform(cx, () => workItems.loadMutationOptions(screen, screen.form),
          { onStart: () => focus.formBack.focus() }),
        replay: (_e, cx) => perform(cx, () => workItems.replayMutation(screen), { preserveFocus: true }),
        history: (_e, cx) => perform(cx, () => workItems.loadHistory(screen), { onStart: () => focus.back.focus() }),
        moreHistory: (_e, cx) => perform(cx, () => workItems.loadHistory(screen, true), { onStart: () => focus.history.focus() }),
        archive: (cx, id) => perform(cx, () => workItems.openArchived(screen, id), { onStart: () => focus.archive.focus() }),
        closeArchive: (_e, cx) => closeArchive(cx),
        archiveExecution: (_e, cx) => openLink(cx, archiveExecution),
        formal: (_e, cx) => openLink(cx, formalLink),
        toggleOutput: (_e, cx) => {
          if (!workItems.isCurrent(screen) || !review) return;
          screen.expandedReview = screen.expandedReview === review.id ? null : review.id;
          cx.notify();
        },
        copyBinding: (_e, cx) => {
          if (workItems.isCurrent(screen) && review?.policy === 'formal') {
            this.copy(cx, `Council-Work-Item-Review: sha256:${review.snapshotSha256}`, 'Formal binding line copied.');
          }
        },
        copyFrozen: (_e, cx) => {
          if (workItems.isCurrent(screen) && review?.capture.output) this.copy(cx, review.capture.output, 'Frozen output copied.');
        },
        copyOutput: (_e, cx) => {
          if (workItems.isCurrent(screen) && screen.item?.result) this.copy(cx, screen.item.result.output, 'Saved handoff copied.');
        }
      }
    };
  }

  openLinked(cx, tab, selection) {
    const previous = { tab: this.tab, selected: this.selected, listProject: this.listProject };
    this.navigate(cx, tab, selection, { trail: [...this.trail, previous], returnTo: this.workspaceReturn });
  }

  goBack(cx) {
    const previous = this.trail.at(-1);
    if (previous) this.navigate(cx, previous.tab, previous.selected, {
      listProject: previous.listProject, trail: this.trail.slice(0, -1), returnTo: this.workspaceReturn
    });
    else if (this.workspaceReturn) this.backToWorkspace(cx);
    else this.navigate(cx, this.tab);
  }

  openWorkspaceHistory(cx, project) {
    const bookmark = this.workspaceBookmark();
    this.navigate(cx, 'delegations', null, { returnTo: bookmark, listProject: project });
    this.search.set_value(bookmark.search);
    this.listFilter = bookmark.group;
    cx.notify();
  }

  backToWorkspace(cx) {
    const { target, search, workItem, ...bookmark } = this.workspaceReturn;
    const focus = focused();
    this.pendingWorkItemReturn = workItem ?? null;
    Object.assign(this.workspace, bookmark, {
      pinned: bookmark.pinned || (focus?.cwd && focus.cwd !== target ? target : null)
    });
    this.navigate(cx, 'activity');
    this.workspace.component = bookmark.component;
    this.activitySearch.set_value(search);
    cx.notify();
  }

  clearFilters() {
    this.search?.set_value('');
    this.activitySearch?.set_value('');
    this.listFilter = 'all';
  }

  refresh(cx) {
    const space = localSpace();
    const folder = space?.folder || null;
    const machine = space?.machine ?? null;
    if (folder !== this.folder || space?.id !== this.spaceId || machine !== this.spaceMachine) {
      this.folder = folder;
      this.spaceId = space?.id;
      this.spaceMachine = machine;
      this.engine = null;
      this.peerEngines.clear();
      this.allSpaces = false;
      this.workspace.pinned = null;
      this.discoveredProjects = [];
      this.lastFocusedProject = null;
      this.pendingWorkItemReturn = null;
      this.clearFilters();
      this.navigate(cx, this.tab);
      return;
    }
    if (!folder || !this.config) return;
    const workItemScreen = this.workItems.current;
    if (workItemScreen && workItemScreen.kind !== 'list' && this.workItemVisible(workItemScreen)) return;
    let target = folder;
    let activityOptions;
    if (this.tab === 'activity') {
      const focus = focused();
      const projects = activityProjects(space, focus);
      const hasProject = folder => [...projects, ...this.discoveredProjects].some(project => folderKey(project) === folderKey(folder));
      if (!hasProject(this.workspace.pinned)) this.workspace.pinned = null;
      if (!hasProject(this.lastFocusedProject)) this.lastFocusedProject = null;
      const focusedFolder = focusedProject(focus, space);
      if (focusedFolder) this.lastFocusedProject = focusedFolder;
      target = this.workspace.pinned || this.lastFocusedProject || folder;
      const followFocus = !this.workspace.pinned;
      activityOptions = { followFocus, spaceFolder: folder, ...(followFocus ? { projects } : {}) };
      if (target !== this.activityTarget || followFocus !== this.activityFollows) {
        this.leaveWorkItems();
        this.activityTarget = target;
        this.activityFollows = followFocus;
        this.workspace.component = null;
        this.data = null;
        this.readError = '';
        this.epoch++;
        this.loading = false;
        cx.notify();
      }
    }
    if (this.loading || this.saving) return;
    this.loading = true;
    const epoch = this.epoch;
    const { tab, selected, listProject } = this;
    cx.spawn(async cx => {
      try {
        const engine = await this.engineFor(space.machine);
        if (epoch !== this.epoch) return;
        this.engine = engine;
        const data = selected
          ? await this.request(selected.project, tab, { id: selected.id }, engine)
          : await this.request(listProject || target, tab, activityOptions ?? {
            projects: listProject ? [] : localProjects(space, this.allSpaces),
            spaceFolders: listProject ? [] : this.allSpaces ? spaces().filter(item => item.machine === space.machine).map(item => item.folder) : [folder]
          }, engine);
        if (epoch === this.epoch) {
          if (tab === 'activity' && activityOptions.followFocus) this.discoveredProjects = data.projects ?? [];
          const changed = this.readError || JSON.stringify(data) !== JSON.stringify(this.data);
          this.readError = '';
          this.data = data;
          this.syncWorkItems(cx, space);
          if (changed) cx.notify();
        }
      } catch (error) {
        if (epoch === this.epoch) {
          this.readError = error.message;
          cx.notify();
        }
      } finally {
        if (epoch === this.epoch) this.loading = false;
      }
    });
  }

  async launchInvitations(folder, id, engine) {
    const name = `council-invite-${id.replace(/-/g, '').slice(-17)}`;
    const args = invitationWorkerArgs(engine, name, folder, id);
    const result = await hc(args);
    if (result.code !== 0 || !JSON.parse(result.stdout)?.address) {
      throw new Error(result.stderr.trim() || 'Herdr did not return a worker address.');
    }
  }

  resumeInvitations(cx) {
    const space = localSpace();
    if (!this.currentSpace(space) || this.recovering || this.saving) return;
    const engine = this.engine;
    this.recovering = true;
    cx.spawn(async () => {
      try {
        const pending = await this.request(space.folder, 'pending-invitations', {
          space: hostId(space.id, space.machine), projects: localProjects(space, true),
          spaceFolders: spaces().filter(item => item.machine === space.machine).map(item => item.folder)
        }, engine);
        for (const { id, project } of pending['pending-invitations']) {
          if (localSpace()?.id !== space.id) break;
          // A running worker or a temporary dispatch error will be reconciled on the next pass.
          try { await this.launchInvitations(project, id, engine); } catch {}
        }
      } catch {
        // A failed scan leaves the persisted queue available to the next pass.
      } finally {
        this.recovering = false;
      }
    });
  }

  invitationAction(cx, address, action) {
    const space = localSpace();
    const selection = this.selected;
    if (!this.currentSpace(space) || !selection || this.saving || this.checkingInvitation) return;
    const engine = this.engine;
    const params = { id: selection.id, space: hostId(space.id, space.machine), address };
    const epoch = this.epoch;
    this.error = '';
    this.checkingInvitation = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        if (action === 'retry') {
          await this.request(selection.project, 'invite-retry', params, engine);
          await this.launchInvitations(selection.project, selection.id, engine);
        } else {
          const result = await executeEngine(exec, engine, 'entry', ['invite-check', JSON.stringify(params)], selection.project, 120000);
          if (result.code !== 0) throw new Error(result.stderr.trim() || 'Council could not check this terminal.');
          const { state } = JSON.parse(result.stdout);
          if (state === 'uncertain') throw new Error('Herdr did not confirm the setup check. Inspect the original terminal before sending another check.');
          notify({ title: state === 'aligned' ? 'This terminal is already aligned.' : 'Setup check sent.', level: 'success', timeout: 2000 });
        }
      } catch (error) {
        if (epoch === this.epoch) this.error = error.message;
      } finally {
        this.checkingInvitation = false;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  renderInvitations(t, record, space) {
    return deliveryView(t, record.invitationDelivery, {
      canAct: !record.closedAt && record.invitationDelivery?.space === hostId(space?.id, space?.machine),
      disabled: this.saving || this.checkingInvitation,
      check: (cx, address) => this.invitationAction(cx, address, 'check'),
      retry: (cx, address) => this.invitationAction(cx, address, 'retry')
    });
  }

  save(cx, action, payload) {
    const space = localSpace();
    if (!this.currentSpace(space) || this.saving) return;
    const engine = this.engine;
    const folder = this.form?.project ?? this.selected?.project ?? this.folder;
    const creation = ['create', 'debate-create'].includes(action);
    const section = action.startsWith('debate-') ? 'debate' : 'poll';
    const recipients = creation ? this.selectedRecipients() : [];
    const request = creation ? { ...payload, space: hostId(space.id, space.machine), recipients } : payload;
    this.saving = true;
    this.loading = false;
    const epoch = ++this.epoch;
    this.error = '';
    cx.notify();
    cx.spawn(async cx => {
      try {
        const record = await this.request(folder, action, request, engine);
        let deliveryError = '';
        if (recipients.length) {
          try {
            await this.launchInvitations(folder, record.id, engine);
          } catch (error) {
            deliveryError = `The ${section} opened and invitations were saved. Herdr will retry starting the worker. ${error.message}`;
          }
        }
        if (epoch !== this.epoch) return;
        if (action === 'team-set' || action === 'activity-report') {
          this.data = record;
          this.clearForm();
          return;
        }
        if (action === 'create' && this.tab !== 'polls') {
          this.tab = 'polls';
          this.pollSection = 'results';
          this.clearFilters();
        }
        this.selected = { id: record.id, project: folder };
        this.data = { [section]: record };
        this.error = deliveryError;
        if (action === 'debate-reply') this.reply.set_value('');
        if (creation) this.backFocus?.focus();
        this.clearForm();
      } catch (error) {
        if (epoch === this.epoch) this.error = error.message;
      } finally {
        if (epoch === this.epoch) {
          this.saving = false;
          this.refresh(cx);
          cx.notify();
        }
      }
    });
  }

  copyInvite(cx, poll, participant) {
    this.copy(cx, invitation(poll, { folder: this.selected.project, cli: this.engine.entry, participant }), 'Invitation copied.');
  }

  copy(cx, text, title) {
    cx.write_to_clipboard(text);
    notify({ title, level: 'success', timeout: 2000 });
  }

  selectPollSection(cx, section) {
    this.pollSection = section;
    this.error = '';
    cx.notify();
  }

  focusAgent(cx, voter, space) {
    if (!this.currentSpace(space) || localSpace()?.id !== space.id || !this.visibleAgents(space).some(agent => agent.address === voter)) {
      this.error = 'That agent is no longer visible.';
      cx.notify();
      return;
    }
    run('agent.focus', { terminal: desktopId(voter, space.machine) });
  }

  visibleAgents(space) {
    const ids = this.allSpaces ? spaces().filter(item => item.machine === space?.machine).map(item => item.id) : [space?.id];
    return agents().filter(agent => ids.includes(agent.space))
      .map(agent => ({ ...agent, address: hostId(agent.address, space?.machine) })).filter(agent => agent.address);
  }

  pollCreator(poll, space) {
    if (!poll.createdBy) return '';
    if (poll.createdBy === 'operator') return 'Opened in Desktop';
    if (poll.interactive) {
      const name = agentName(poll.creatorIdentity?.agent);
      return name ? `Opened by ${name} (${poll.createdBy})` : `Opened by ${poll.createdBy}`;
    }
    const agent = this.visibleAgents(space).find(agent => agent.address === poll.createdBy);
    return `Opened by ${agent?.program?.name ?? poll.createdBy}`;
  }

  startCreate(cx, source, project) {
    project = project || this.selected?.project || this.draftProject();
    const debate = this.tab === 'debates' && !source;
    this.setForm(debate ? 'create-debate' : 'create', {
      question: source?.task ?? '',
      context: source?.messages.find(message => message.id === 'opening')?.body ?? ''
    }, {
      recipients: new Map(), mode: 'choice', options: [], sourceDebateId: source?.id, project
    });
    if (!debate) {
      this.addDraftOption();
      this.addDraftOption();
    }
    cx.notify();
  }

  renderDebateClose(t, debate) {
    const form = this.form;
    return panel(t)
      .child(cardHeading(t, 'Close with a decision', 'check'))
      .child(field(t, 'Decision', form.decision))
      .child(field(t, 'Owner', form.owner))
      .child(field(t, 'Next step', form.nextStep))
      .child(h_flex().gap(6).justify_end()
        .child(button(t, 'cancel-debate-close', 'Cancel', (_e, cx) => {
          this.clearForm();
          this.error = '';
          cx.notify();
        }, 'normal', this.saving))
        .child(button(t, 'save-debate-close', 'Close debate', (_e, cx) => this.save(cx, 'debate-close', {
          id: debate.id, decision: form.decision.value(), owner: form.owner.value(), nextStep: form.nextStep.value()
        }), 'primary', this.saving, 'check')));
  }

  renderProgressNote(t, job) {
    const form = this.form;
    return v_flex().gap(7).p(8).rounded(6).bg(t.background)
      .child(field(t, 'Update', form.text))
      .child(field(t, 'Plan component ID (optional)', form.component))
      .child(h_flex().gap(6).flex_wrap().children([['working', 'Progress'], ['blocked', 'Blocker'], ['handoff', 'Handoff']].map(([id, title]) =>
        button(t, `note-state-${id}`, title, (_e, cx) => { form.state = id; cx.notify(); },
          form.state === id ? 'active' : 'normal', this.saving))))
      .child(h_flex().gap(6)
        .child(button(t, 'save-run-note', 'Save update', (_e, cx) => this.save(cx, 'activity-report', {
          sessionId: job.id, text: form.text.value(), state: form.state, component: form.component.value().trim() || undefined,
          requestId: form.requestId
        }), 'primary', this.saving))
        .child(button(t, 'cancel-run-note', 'Cancel', (_e, cx) => { this.clearForm(); this.error = ''; cx.notify(); }, 'normal', this.saving)));
  }

  selectedRecipients() {
    return [...this.form.recipients.values()].map(({ address, label, createdAt }) => ({ address, label, createdAt }));
  }

  recipientPicker(t, space, limit) {
    const selection = this.form.recipients;
    const live = new Map(spaceRecipients(space).map(person => [recipientKey(person), person]));
    const people = new Map(live);
    for (const [key, person] of selection) {
      if (!people.has(key)) people.set(key, person);
    }
    const selected = selection.size;
    const picker = v_flex().w_full().gap(7).pt(9).border_t_1().border_color(t.border)
      .child(h_flex().items_center().justify_between().gap(8)
        .child(cardHeading(t, 'Invite agents', 'people'))
        .child(label(selected === 0 ? 'No invitations' : `${selected} selected`, 11, t.muted)));
    if (!people.size) return picker.child(label('No live agents in this space.', 12, t.muted));
    for (const [key, person] of people) {
      const chosen = selection.has(key);
      const available = live.has(key) && eligibleRecipient(person);
      const addressSelected = [...selection.values()].some(target => target.address === person.address);
      const status = available ? recipientStatuses[person.status] ?? person.status : 'Unavailable';
      picker.child(h_flex().w_full().gap(8).items_center().px(8).py(6).rounded(6).bg(t.background)
        .child(v_flex().flex_1().min_w_0().gap(3)
          .child(label(`${person.label} · ${person.address}`, 12, t.foreground).font_medium())
          .child(label(projectName(person.folder), 11, t.muted).truncate().tooltip(person.folder)))
        .child(statusPill(t, status, available ? t[person.status] ?? t.muted : t.muted))
        .child(button(t, `recipient-${key}`, chosen ? 'Selected' : 'Select', (_e, cx) => {
          if (chosen) selection.delete(key);
          else selection.set(key, person);
          cx.notify();
        }, chosen ? 'active' : 'normal', this.saving || (!chosen && (!available || addressSelected || selected >= limit)),
        chosen ? 'check' : 'add').w(88)));
    }
    return picker;
  }

  addDraftOption() {
    const input = InputState.new();
    this.form.options.push(input);
    this.form.inputs.push(input);
  }

  renderCreate(t, space) {
    const form = this.form;
    const debate = form.kind === 'create-debate';
    const fields = panel(t)
      .child(label(debate ? 'New debate' : form.sourceDebateId ? 'New poll from debate' : 'New poll', 16, t.foreground).font_semibold())
      .when(Boolean(form.project), node => node.child(label(projectName(form.project), 11, t.muted).tooltip(form.project)))
      .child(field(t, debate ? 'Topic' : 'Question', form.question))
      .child(field(t, debate ? 'Opening message (optional)' : 'Context (optional)', form.context));
    if (!debate) fields.child(label('Response format', 11, t.muted))
      .child(h_flex().gap(5).flex_wrap().children(modes.map(([mode, title]) =>
        button(t, `mode-${mode}`, title, (_e, cx) => {
          form.mode = mode;
          cx.notify();
        }, mode === form.mode ? 'active' : 'normal', this.saving))));
    if (!debate && form.mode !== 'open') {
      fields.children(form.options.map((state, index) => h_flex().gap(8).items_end()
        .child(div().min_w_0().flex_1().child(field(t, `Option ${index + 1}`, state)))
        .when(form.options.length > 2, row => row.child(button(t, `remove-option-${index}`, 'Remove', (_e, cx) => {
          form.options.splice(index, 1);
          form.inputs = form.inputs.filter(input => input !== state);
          state.release();
          cx.notify();
        }, 'normal', this.saving).h(34)))))
        .child(h_flex().child(button(t, 'draft-option', 'Add option', (_e, cx) => {
          this.addDraftOption();
          cx.notify();
        }, 'normal', this.saving || form.options.length >= 20, 'add')));
    }
    return fields.child(this.recipientPicker(t, space, debate ? Infinity : 32)).child(h_flex().gap(6).justify_end()
      .child(button(t, 'cancel-create', 'Cancel', (_e, cx) => {
        if (this.workspaceReturn && !this.selected) this.backToWorkspace(cx);
        else this.cancelForm(cx);
      }, 'normal', this.saving))
      .child(button(t, 'create', debate ? 'Start debate' : 'Open poll', (_e, cx) => this.save(cx, debate ? 'debate-create' : 'create', {
        question: form.question.value(),
        context: form.context.value(),
        mode: form.mode,
        sourceDebateId: form.sourceDebateId,
        options: debate || form.mode === 'open' ? [] : form.options.map(input => input.value()).filter(value => value.trim())
      }), 'primary', this.saving)));
  }

  renderPollForm(t, poll) {
    const form = this.form;
    const card = panel(t);
    let action;
    let payload;
    let title;
    if (form.kind === 'option') {
      action = 'add-option';
      title = 'Add option';
      card.child(field(t, 'Option label', form.value));
      payload = () => ({ label: form.value.value() });
    } else if (form.kind === 'close') {
      action = 'close';
      title = 'Confirm close';
      const pending = poll.participation.expected - poll.participation.received;
      card.child(label('Closing freezes the poll.', 12, t.muted))
        .when(pending > 0, node => node.child(label(
          `${countLabel(pending, 'tracked agent')} still to respond.`, 12, t.working)))
        .child(field(t, 'Decision or next step (optional)', form.value));
      payload = () => ({ outcome: form.value.value() });
    } else {
      action = 'vote';
      title = 'Save response';
      card.child(label('Your response', 13, t.foreground).font_semibold())
        .child(v_flex().gap(5).children(poll.options.map(option =>
          button(t, `vote-${option.id}`, option.label, (_e, cx) => {
            form.choice = option.id;
            cx.notify();
          }, form.choice === option.id ? 'active' : 'normal', this.saving).h('auto').min_h(30).py(5).whitespace_normal())));
      if (poll.mode === 'mixed') {
        card.child(h_flex().child(button(t, 'vote-free', 'Free response', (_e, cx) => {
          form.choice = 'free';
          cx.notify();
        }, form.choice === 'free' ? 'active' : 'normal', this.saving)));
      }
      if (form.choice === 'free') card.child(field(t, 'Response', form.answer));
      card.child(field(t, 'Rationale (optional)', form.note));
      payload = () => form.choice === 'free'
        ? { answer: form.answer.value(), note: form.note.value() }
        : { optionId: form.choice, note: form.note.value() };
    }
    return card.child(h_flex().gap(6).justify_end()
      .child(button(t, 'cancel-form', 'Cancel', (_e, cx) => this.cancelForm(cx), 'normal', this.saving))
      .child(button(t, 'save-form', title, (_e, cx) => this.save(cx, action, { id: poll.id, ...payload() }),
        'primary', this.saving || (action === 'vote' && !form.choice))));
  }

  renderPoll(t, poll, space) {
    const { expected, received } = poll.participation;
    const mine = poll.responses.find(response => response.voter === 'operator');
    const editing = Boolean(this.form && !poll.closedAt);
    const header = panel(t).gap(10)
      .child(h_flex().w_full().justify_between().items_center().gap(8)
        .child(statusPill(t, pollStatus(poll), poll.closedAt ? t.muted : t.done))
        .child(label(modes.find(([id]) => id === poll.mode)?.[1] ?? '', 11, t.muted)))
      .child(label(poll.question, 20, t.foreground).font_semibold())
      .child(label([projectName(this.selected.project), this.pollCreator(poll, space)].filter(Boolean).join(' · '), 11, t.muted))
      .when(Boolean(poll.context), node => node.child(label(poll.context, 13, t.muted)));
    const delivery = this.renderInvitations(t, poll, space);
    if (delivery) header.child(delivery);
    if (poll.outcome) header.child(v_flex().w_full().gap(4).pt(8).border_t_1().border_color(t.border)
      .child(label('Decision / next step', 11, t.accent).font_semibold())
      .child(label(poll.outcome, 14, t.foreground)));
    if (editing) return v_flex().w_full().gap(10).child(header).child(this.renderPollForm(t, poll));

    const actions = h_flex().gap(6).flex_wrap();
    if (poll.sourceDebateId) actions.child(button(t, 'poll-debate-source', 'View debate', (_e, cx) =>
      this.openLinked(cx, 'debates', { id: poll.sourceDebateId, project: this.selected.project }), 'normal', this.saving, 'debates'));
    if (!poll.closedAt) {
      actions.child(button(t, 'respond', mine ? 'Edit response' : 'Respond', (_e, cx) => {
        this.setForm('vote', { answer: mine?.answer ?? '', note: mine?.note ?? '' }, {
          choice: mine?.optionId || (poll.mode === 'open' || mine?.answer ? 'free' : null)
        });
        cx.notify();
      }, 'primary', this.saving, 'check')).child(button(t, 'copy-invite', 'Copy invite', (_e, cx) => this.copyInvite(cx, poll), 'normal', false, 'copy'))
        .when(poll.mode !== 'open' && poll.options.length < 20, row => row.child(
          button(t, 'add-option', 'Add option', (_e, cx) => { this.setForm('option', { value: '' }); cx.notify(); }, 'normal', this.saving, 'add')))
        .child(button(t, 'close', 'Close poll', (_e, cx) => { this.setForm('close', { value: '' }); cx.notify(); }, 'normal', this.saving));
    }
    actions.child(button(t, 'copy-summary', poll.outcome ? 'Copy decision' : 'Copy results', (_e, cx) =>
      this.copy(cx, decisionSummary(poll, this.selected.project), 'Results copied.'), poll.closedAt ? 'primary' : 'normal', false, 'copy'));

    const switchView = h_flex().gap(6)
      .child(button(t, 'poll-results', 'Results', (_e, cx) => this.selectPollSection(cx, 'results'),
        this.pollSection === 'results' ? 'active' : 'normal', this.saving, 'polls'))
      .child(button(t, 'poll-participants', expected && this.pollSection === 'results' ? `Participants · ${received}/${expected}` : 'Participants',
        (_e, cx) => this.selectPollSection(cx, 'participants'),
        this.pollSection === 'participants' ? 'active' : 'normal', this.saving, 'people'));

    const content = this.pollSection === 'participants'
      ? pollParticipants(t, poll, this.visibleAgents(space), this.saving, {
        invite: (cx, participant) => this.copyInvite(cx, poll, participant),
        focus: (cx, voter) => this.focusAgent(cx, voter, space),
        track: (cx, participant) => this.save(cx, 'track', { id: poll.id, ...participant }),
        untrack: (cx, voter) => this.save(cx, 'untrack', { id: poll.id, voter })
      }, this.wide)
      : pollResults(t, poll, this.wide);
    return v_flex().w_full().gap(10).child(header.child(actions)).child(switchView).child(content);
  }

  renderReview(t, review) {
    const { tally, validation } = review;
    const round = review.roundActions;
    const card = panel(t)
      .child(h_flex().child(statusPill(t, reviewStatus(review.status), review.status === 'approved' ? t.done : t.muted)))
      .child(label(review.task, 17, t.foreground).font_semibold())
      .child(label(projectName(this.selected.project), 11, t.muted))
      .child(h_flex().child(button(t, 'open-debate', 'View discussion', (_e, cx) => this.openLinked(cx, 'debates', this.selected), 'normal', false, 'debates')));
    if (round) card.child(h_flex().gap(6).flex_wrap()
      .child(button(t, 'retally', 'Refresh tally', (_e, cx) => this.changeRound(cx, review, false), 'normal', this.saving))
      .children((round.nextJobIds ?? (round.nextJobId ? [round.nextJobId] : [])).map(id =>
        button(t, 'open-next-round-' + id, round.nextJobIds?.length > 1 ? `Open ${id}` : 'Open next round', (_e, cx) =>
          this.openLinked(cx, 'delegations', { id, project: this.selected.project }), 'normal', this.saving, 'right')))
      .when(!round.nextJobId && round.canStartNext, row => row.child(button(t, 'next-round', 'Start next round', (_e, cx) =>
        this.changeRound(cx, review, true), 'primary', this.saving, 'add'))));
    const results = panel(t)
      .child(cardHeading(t, 'Direct ballots', 'reviews'));
    if (tally) {
      const missing = Math.max(0, tally.expectedCount - tally.validCastCount - tally.invalidCount);
      results.child(label(`Saved tally · ${tally.validCastCount}/${tally.expectedCount} valid · ${tally.quorumMet ? 'Quorum met' : 'Quorum unmet'}`, 12, t.muted))
        .child(progress(t, 'Approve', tally.approveCount, tally.expectedCount, t.done))
        .child(progress(t, 'Amend', tally.amendCount, tally.expectedCount, t.working))
        .child(progress(t, 'Reject', tally.rejectCount, tally.expectedCount, t.blocked))
        .when(tally.invalidCount > 0, node => node.child(label(countLabel(tally.invalidCount, 'invalid ballot'), 12, t.blocked)))
        .when(missing > 0, node => node.child(label(countLabel(missing, 'missing ballot'), 12, t.muted)));
    } else {
      results.child(label(review.ballots.length ? `${countLabel(review.ballots.length, 'submission')} · Awaiting validation` : 'No direct ballots submitted yet.', 12, t.muted));
    }
    if (validation?.rationale) card.child(label(validation.rationale, 12, t.muted));
    for (const condition of validation?.conditions ?? []) card.child(label(`• ${condition}`, 12, t.foreground));
    if (review.proposal?.sha256) card.child(h_flex().child(button(t, 'copy-sha', 'Copy proposal SHA', (_e, cx) =>
      this.copy(cx, review.proposal.sha256, 'Proposal SHA copied.'), 'normal', false, 'copy')));
    if (review.reportPath) card.child(h_flex().child(button(t, 'copy-report', 'Copy report path', (_e, cx) =>
      this.copy(cx, review.reportPath, 'Report path copied.'), 'normal', false, 'copy')));
    const ballots = review.ballots.length ? review.ballots : (tally?.sortedBallots ?? []).map(ballot => ({
      ...tally.dissent?.find(item => item.voter === ballot.voter), ...ballot
    }));
    for (const ballot of ballots) {
      results.child(v_flex().gap(5).pt(8).border_t_1().border_color(t.border)
        .child(label([ballot.voter, ballot.agent].filter(Boolean).join(' · '), 12, t.accent).font_semibold())
        .child(ballotBody(t, ballot)));
    }
    return columns(this.wide, card, results, 300);
  }

  renderList(t, space) {
    const isPolls = this.tab === 'polls';
    const isDelegations = this.tab === 'delegations';
    const items = this.data?.[this.tab] ?? [];
    const body = v_flex().w_full().min_w_0().gap(8);
    if (this.listProject) body.child(h_flex().gap(6).items_center()
      .child(statusPill(t, projectName(this.listProject), t.accent).tooltip(this.listProject)));
    else body.child(h_flex().gap(6).flex_wrap().children([[false, 'This space'], [true, space.machine ? 'All spaces on this machine' : 'All local spaces']].map(([all, title]) =>
        button(t, `scope-${all}`, title, (_e, cx) => {
          if (all === this.allSpaces) return;
          this.allSpaces = all;
          this.navigate(cx, this.tab);
        }, this.allSpaces === all ? 'active' : 'normal'))));
    if (!items.length) {
      const empty = {
        polls: 'Polls opened by you or agents in these projects appear here.',
        delegations: 'Delegations, parallel runs, and pipelines started in these projects appear here.',
        debates: 'Debate threads, automated debates, and formal reviews started in these projects appear here.',
        reviews: 'Council and review sessions appear here as soon as they start.'
      };
      return body.child(panel(t).py(20).child(h_flex().gap(11).items_center()
        .child(iconTile(t, this.tab, 38))
        .child(v_flex().flex_1().min_w_0().gap(4)
          .child(label(`No ${this.tab} yet`, 14, t.foreground).font_semibold())
          .child(label(empty[this.tab], 12, t.muted)))));
    }

    const query = this.search?.value().trim().toLowerCase() ?? '';
    const visible = items.filter(item => {
      const matchesQuery = [item.question, item.id, item.project, item.createdBy, agentName(item.creatorIdentity?.agent)]
        .some(value => value?.toLowerCase().includes(query));
      const group = isPolls ? (item.closedAt ? 'closed' : 'open')
        : isDelegations ? delegationStatus(t, item.status).group : null;
      const matchesStatus = this.listFilter === 'all' || group === this.listFilter;
      return matchesQuery && matchesStatus;
    });
    body.child(input(t, this.search, 'search'));
    const filters = isPolls ? [['open', 'Open'], ['closed', 'Closed']]
      : isDelegations ? [['active', 'Active'], ['attention', 'Needs attention'], ['ready', 'Ready']] : [];
    if (filters.length) {
      body.child(h_flex().gap(6).flex_wrap().children([['all', 'All'], ...filters].map(([id, title]) =>
        button(t, `filter-${id}`, title, (_e, cx) => {
          this.listFilter = id;
          cx.notify();
        }, this.listFilter === id ? 'active' : 'normal'))));
    }
    if (!visible.length) return body.child(panel(t)
      .child(label('No matches', 14, t.foreground).font_semibold())
      .child(h_flex().child(button(t, 'clear-filters', 'Clear filters', (_e, cx) => {
        this.clearFilters();
        cx.notify();
      }))));

    const origins = projectLabels(items.map(item => item.project));
    return body.children(visible.map(item => {
      const { expected, received } = item.participation ?? {};
      const status = isDelegations ? delegationStatus(t, item.status) : {
        title: isPolls ? pollStatus(item) : reviewStatus(item.status),
        color: (isPolls ? !item.closedAt : item.status === 'approved') ? t.done : t.muted
      };
      const metadata = isDelegations ? [discussionType(item), item.agent ?? (item.ownership === 'borrowed' ? 'Existing terminal' : null), item.address].filter(Boolean).join(' · ')
        : !isPolls ? discussionType(item) : expected
          ? `${received}/${expected} tracked replied · ${countLabel(item.responseCount, 'response')}`
          : countLabel(item.responseCount, 'response');
      const origin = [origins.get(item.project), item.createdBy ? this.pollCreator(item, space) : null].filter(Boolean).join(' · ');
      return Button.new(`${item.project}/${item.id}`).w_full().min_w_0().px(12).py(11).rounded(9).items_center()
        .border_1().border_color(t.border).bg(t.surface).cursor_pointer()
        .accessibility_label([item.question, origin, metadata, status.title].filter(Boolean).join(', '))
        .tab_stop(true).focus(s => s.border_color(t.accent))
        .hover(s => s.bg(t.raised).border_color(t.input))
        .on_mouse_down('left', (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.navigate(cx, this.tab, { id: item.id, project: item.project }, { returnTo: this.workspaceReturn }))
        .child(h_flex().w_full().min_w_0().gap(10).items_center()
          .child(iconTile(t, this.tab))
          .child(v_flex().min_w_0().flex_1().gap(5)
            .child(label(item.question, 14, t.foreground).font_semibold())
            .child(label(origin, 11, t.muted).tooltip(item.project))
            .child(h_flex().items_center().gap(7).flex_wrap()
              .child(statusPill(t, status.title, status.color))
              .when(Boolean(metadata), node => node.child(label(metadata, 11, t.muted)))))
          .child(glyph('right', 14).text_color(t.muted)));
    }));
  }

  renderContent(t, space) {
    if (this.configError) return label(this.configError, 13, t.blocked);
    if (!space?.folder) return panel(t).child(label('Open a Herdr space with a project folder.', 13, t.muted));
    if (space.id !== this.spaceId || space.folder !== this.folder || (!this.data && !this.readError)) {
      return this.tab === 'activity' ? panel(t).role('status').child(cardHeading(t, 'Loading Workspace…', 'activity'))
        : label('Loading project…', 12, t.muted);
    }
    if (!this.data && this.readError) return div();
    if (this.tab === 'activity') {
      const project = this.data.project;
      const projects = [...new Map([...this.discoveredProjects, ...activityProjects(space, focused())]
        .map(path => [folderKey(path), path])).values()];
      const key = folderKey(project);
      const live = spaceRecipients(space).filter(agent => {
        const folder = folderKey(agent.folder);
        return !this.workspace.pinned || folder === key || folder.startsWith(`${key}/`);
      });
      const update = (cx, changes) => {
        Object.assign(this.workspace, changes);
        cx.notify();
      };
      const workItems = this.workspace.view === 'work-items' ? this.workItemViewProps() : null;
      return workspaceView(t, this.data, {
        ...this.workspace, projects, live, workItems, workItemsTab: this.lifecycleFocus.tab, wide: this.wide, search: this.activitySearch
      }, {
        open: (cx, tab, id, origin = project) => this.navigate(cx, tab, { id, project: origin }, { returnTo: this.workspaceBookmark() }),
        history: cx => this.openWorkspaceHistory(cx, project),
        create: (cx, tab) => {
          this.navigate(cx, tab, null, { returnTo: this.workspaceBookmark() });
          this.startCreate(cx, null, project);
        },
        focus: (cx, address) => this.focusAgent(cx, address, space),
        project: (cx, pinned) => {
          this.leaveWorkItems();
          this.workspace.pinned = pinned;
          this.refresh(cx);
          this.syncWorkItems(cx);
          cx.notify();
        },
        showRuns: (cx, group) => update(cx, { view: 'runs', group, limit: 9 }),
        view: (cx, view) => {
          const previous = this.workspace.view;
          if (view === 'work-items' && previous === view) return;
          this.leaveWorkItems();
          this.activitySearch.set_value('');
          update(cx, { view, limit: 9 });
          if (view === 'work-items' || previous === 'work-items') {
            this.refresh(cx);
            this.syncWorkItems(cx);
          }
        },
        component: (cx, component) => update(cx, { component }),
        more: cx => update(cx, { limit: this.workspace.limit + 9 }),
        diagnostics: cx => update(cx, { diagnostics: !this.workspace.diagnostics }),
        sample: cx => this.copy(cx, samplePlan, 'Sample PLAN.md copied.'),
        copyPath: (cx, path) => this.copy(cx, path, 'Path copied.')
      });
    }
    if (this.form?.kind === 'task') return this.withProjectPicker(t, space, taskEditor(t, this.form, {
      saving: this.saving, submit: cx => this.launchTask(cx), cancel: cx => this.cancelForm(cx)
    }));
    if (this.tab === 'schedules') {
      const schedules = renderSchedules(t, this, (cx, action) => this.changeSchedule(cx, action));
      return this.form?.kind === 'schedule' ? this.withProjectPicker(t, space, schedules) : schedules;
    }
    if (this.tab === 'team') {
      if (this.form?.kind === 'team') return teamEditor(t, this.data, this.form, {
        saving: this.saving,
        save: (cx, profile) => this.save(cx, 'team-set', profile),
        cancel: cx => { this.clearForm(); cx.notify(); }
      });
      const target = { project: this.listProject ?? this.folder, engine: this.engine, spaceId: space.id };
      return teamView(t, this.data, {
        edit: (cx, member) => this.editTeamMember(cx, member),
        call: (cx, member) => {
          if (this.tab !== 'team' || !this.currentSpace() || target.spaceId !== this.spaceId ||
              target.engine?.machine !== this.engine.machine || target.project !== (this.listProject ?? this.folder)) return;
          this.newTask(cx, { member, target });
        },
        open: (cx, id) => this.navigate(cx, 'delegations', { id, project: this.listProject ?? this.folder }, { returnTo: this.workspaceReturn })
      });
    }
    if (['create', 'create-debate'].includes(this.form?.kind)) return this.withProjectPicker(t, space, this.renderCreate(t, space));
    if (this.selected) {
      const detail = this.data?.[this.tab.slice(0, -1)];
      if (!detail) return label('This item is unavailable.', 12, t.muted);
      if (this.tab === 'polls') return this.renderPoll(t, detail, space);
      if (this.tab === 'reviews') return this.renderReview(t, detail);
      if (this.tab === 'delegations' && detail.standalone) return discussionView(t, detail, {
        project: projectName(this.selected.project),
        copy: (cx, value) => this.copy(cx, value, 'File path copied.')
      });
      if (this.tab === 'debates') return discussionView(t, detail, {
        project: projectName(this.selected.project),
        openReview: (_e, cx) => this.openLinked(cx, 'reviews', this.selected),
        creator: this.pollCreator(detail, space),
        copy: (cx, value) => this.copy(cx, value, 'Contribution path copied.'),
        delivery: this.renderInvitations(t, detail, space),
        startPoll: (_e, cx) => this.startCreate(cx, detail),
        startClose: (_e, cx) => {
          this.setForm('close-debate', { decision: '', owner: '', nextStep: '' });
          cx.notify();
        },
        openPoll: (cx, id) => this.openLinked(cx, 'polls', { id, project: this.selected.project }),
        copyDecision: (cx, text) => this.copy(cx, `${text}\nProject: ${this.selected.project}`, 'Decision copied.'),
        closing: this.form?.kind === 'close-debate' && !detail.closedAt ? this.renderDebateClose(t, detail) : null,
        saving: this.saving,
        composer: detail.interactive && !detail.closedAt && !this.form ? h_flex().w_full().gap(8).items_center()
          .child(div().flex_1().min_w_0().child(input(t, this.reply).accessibility_label('Debate reply')))
          .child(button(t, 'post-reply', 'Reply', (_e, cx) => this.postReply(cx), 'primary', this.saving || !this.reply.value().trim())) : null
      });
      return delegationView(t, detail, {
        wide: this.wide,
        terminal: participantTerminal(detail, space.machine, terminals()),
        focus: () => {
          const terminal = participantTerminal(detail, space.machine, terminals());
          if (this.currentSpace() && localSpace()?.id === space.id && terminal) run('terminal.peek', { terminal: terminal.address });
        },
        open: (cx, id) => this.openLinked(cx, 'delegations', { id, project: this.selected.project }),
        openWorkflow: detail.workflowTab ? cx =>
          this.openLinked(cx, detail.workflowTab, { id: detail.workflowSessionId, project: this.selected.project }) : null,
        addNote: (_e, cx) => {
          const requestId = `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
          this.setForm('progress-note', { text: '', component: '' }, { state: 'working', requestId });
          cx.notify();
        },
        composer: this.form?.kind === 'progress-note' ? this.renderProgressNote(t, detail) : null,
        copy: (cx, value, title) => this.copy(cx, value, title)
      });
    }
    return this.renderList(t, space);
  }

  editTeamMember(cx, member) {
    this.setForm('team', {
      id: '', role: member?.role ?? '', model: member?.model ?? '', instructions: member?.instructions ?? ''
    }, {
      project: this.listProject ?? this.folder,
      memberId: member?.id ?? null, agent: member?.agent ?? 'codex',
      reportsTo: member?.reportsTo ?? '', permission: member?.permission ?? 'read'
    });
    cx.notify();
  }

  postReply(cx) {
    const debate = this.data?.debate;
    if (this.tab === 'debates' && this.selected?.id === debate?.id && debate?.interactive && !debate.closedAt &&
        this.reply.value().trim()) this.save(cx, 'debate-reply', { id: debate.id, text: this.reply.value() });
  }

  draftProject() {
    return this.listProject || this.workspace.pinned || focusedProject(focused(), localSpace()) || this.folder;
  }

  withProjectPicker(t, space, editor) {
    const form = this.form;
    if (form.member || form.sourceDebateId || this.listProject || form.submitted) return editor;
    const records = this.data?.[this.tab];
    const folders = [form.project, ...localProjects(space, this.allSpaces), ...this.discoveredProjects,
      ...(Array.isArray(records) ? records.map(item => item.project) : [])].filter(Boolean);
    const projects = [...new Map(folders.map(path => [folderKey(path), path])).values()];
    if (projects.length < 2) return editor;
    const names = projectLabels(projects);
    const picker = panel(t).child(label('Project', 12, t.foreground).font_semibold())
      .child(h_flex().gap(5).flex_wrap().children(projects.map(path => button(t, 'draft-' + path, names.get(path),
        (_e, cx) => { form.project = path; cx.notify(); }, path === form.project ? 'active' : 'normal', this.saving).tooltip(path))));
    return v_flex().w_full().gap(8).child(picker).child(editor);
  }

  changeSchedule(cx, action) {
    if (!this.currentSpace() || this.saving) return;
    const engine = this.engine;
    changeSchedule(this, cx, action, (project, args) => this.runCli(project, args, engine));
  }

  changeRound(cx, review, start) {
    if (!this.currentSpace() || this.saving || this.selected?.id !== review.id) return;
    const { project } = this.selected;
    const engine = this.engine;
    this.saving = true;
    this.loading = false;
    this.error = '';
    const epoch = ++this.epoch;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const dispatch = args => this.runCli(project, args, engine);
        if (start) {
          const id = await startFormalRound(review, dispatch);
          if (epoch === this.epoch) this.openLinked(cx, 'delegations', { id, project });
        } else {
          const tally = await refreshFormalTally(review, dispatch);
          if (epoch === this.epoch) notify({ title: `Tally refreshed · ${reviewStatus(tally.status)}`, level: 'success', timeout: 2500 });
        }
      } catch (error) {
        if (epoch === this.epoch) this.error = error.message;
      } finally {
        if (epoch === this.epoch) {
          this.saving = false;
          this.refresh(cx);
          cx.notify();
        }
      }
    });
  }

  newTask(cx, { member = null, mode = 'delegate', target } = {}) {
    const { fields, extra } = taskFormDefaults(mode);
    this.setForm('task', fields, {
      ...extra, member, project: target?.project ?? this.draftProject(), teamTarget: target,
      sessionId: `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
    });
    cx.notify();
  }

  launchTask(cx) {
    const space = localSpace();
    const form = this.form;
    if (form?.kind !== 'task' || this.saving || !this.currentSpace(space)) return;
    const { project, teamTarget } = form;
    if (teamTarget && (space.id !== teamTarget.spaceId || (space.machine ?? null) !== teamTarget.engine.machine)) return;
    const engine = teamTarget?.engine ?? this.engine;
    const params = taskFormValues(form);
    this.saving = true;
    this.loading = false;
    this.error = '';
    const epoch = ++this.epoch;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const id = await submitTask(params, args => {
          form.submitted = true;
          return this.runCli(project, args, engine);
        },
          assignment => this.request(project, 'task-match', assignment, engine));
        if (epoch === this.epoch) this.navigate(cx, 'delegations', { id, project }, { returnTo: this.workspaceReturn });
      } catch (error) {
        if (epoch === this.epoch) this.error = error.message;
      } finally {
        if (epoch === this.epoch) {
          this.saving = false;
          this.refresh(cx);
          cx.notify();
        }
      }
    });
  }

  render() {
    const t = theme();
    if (this.role === 'launcher') return launcher(t, this.compact, (size, cx) => {
      const compact = size.width < 115;
      if (this.compact === compact) return;
      this.compact = compact;
      cx.notify();
    });
    if (this.role === 'menu') return menu(t, this.menuFocus, this.menuIndex, (cx, step) => {
      this.menuIndex = (this.menuIndex + step + sections.length) % sections.length;
      cx.notify();
    });
    const space = localSpace();
    const overlay = props()?.overlay;
    const sameSpace = Boolean(this.config && space?.folder && space.folder === this.folder && space.id === this.spaceId);
    const current = this.currentSpace(space);
    const tabs = h_flex().w_full().gap(4).p(3).rounded(9).border_1().border_color(t.border).bg(t.background)
      .when(!this.wideNavigation, row => row.flex_wrap())
      .role('tab_list').accessibility_label('Council sections').children(sections.map(({ id, title }, position) =>
        sectionTab(t, id, title, this.tab === id, (_e, cx) => {
          if (this.tab !== id) this.navigate(cx, id);
        }, this.saving, this.wideNavigation).set_position(position + 1, sections.length)));
    const header = v_flex().flex_shrink_0().gap(12).p(14).bg(t.surface).border_b_1().border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(brandMark(40))
        .child(v_flex().flex_1().min_w_0().gap(2)
          .child(label('Council', 19, t.foreground).font_semibold())
          .when(Boolean(space?.folder) && (this.tab !== 'activity' || Boolean(space.machine)), node =>
            node.child(label([space.name || space.folder, space.machine].filter(Boolean).join(' · '), 12, t.muted).truncate())))
        .when(current && ['debates', 'reviews'].includes(this.tab) && !this.selected && !this.form, node =>
          node.child(button(t, 'new-formal-workflow', this.tab === 'debates' ? 'Run agent debate' : 'Start review', (_e, cx) =>
            this.newTask(cx, { mode: this.tab === 'debates' ? 'debate' : 'review' }), 'normal', false, 'add')))
        .when(current && ['polls', 'debates'].includes(this.tab) && !this.selected && !this.form, node =>
          node.child(button(t, 'new', this.tab === 'polls' ? 'New poll' : 'New debate', (_e, cx) => this.startCreate(cx), 'primary', false, 'add').track_focus(this.newFocus)))
        .when(current && this.tab === 'delegations' && !this.selected && !this.form, node =>
          node.child(button(t, 'new-task', 'Start workflow', (_e, cx) => this.newTask(cx), 'primary', false, 'add').track_focus(this.newFocus)))
        .when(current && this.tab === 'schedules' && !this.selected && !this.form, node =>
          node.child(button(t, 'new-schedule', 'New schedule', (_e, cx) => newSchedule(this, cx, this.draftProject()), 'primary', false, 'add').track_focus(this.newFocus)))
        .when(current && this.tab === 'team' && Boolean(this.data) && !this.form, node =>
          node.child(button(t, 'add-member', 'Add member', (_e, cx) => this.editTeamMember(cx), 'primary', false, 'add')))
        .when(current && Boolean(this.selected || this.listProject), node =>
          node.child(button(t, 'back', this.trail.length ? 'Back' : this.workspaceReturn ? 'Back to Workspace' : `All ${this.tab}`,
            (_e, cx) => this.goBack(cx), 'normal', this.saving, 'back').track_focus(this.backFocus)))
        .when(Boolean(overlay), node =>
          node.child(button(t, 'dismiss-panel', '', () => closeOverlay(overlay), 'normal', false, 'close')
            .w(30).px(0).tooltip('Close Council').accessibility_label('Close Council'))))
      .child(tabs);
    const body = v_flex().id(`content-${this.tab}-${this.selected?.id ?? 'list'}-${this.form?.kind ?? this.pollSection}`)
      .flex_1().min_h(0).w_full().gap(10).p(14).overflow_y_scrollbar()
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation());
    if ((current || !this.config) && this.error) body.child(label(this.error, 12, t.blocked));
    if (sameSpace && this.readError) {
      body.child(h_flex().gap(8).items_center()
        .child(label(`Refresh failed. ${this.readError}`, 12, t.blocked).flex_1())
        .child(button(t, 'retry-read', 'Retry', (_e, cx) => this.refresh(cx))));
    }
    if (current && this.tab !== 'activity' && this.data?.errors?.length) {
      body.child(label(`${countLabel(this.data.errors.length, 'record')} could not be read.`, 12, t.blocked));
    }
    return v_flex().id('council-root').size_full().min_h(0).min_w_0().bg(t.chrome).text_color(t.foreground)
      .track_focus(this.panelFocus).tab_stop(false).on_key_down((event, cx) => {
        if (event.key === 'tab' && !event.modifiers.control && !event.modifiers.alt && !event.modifiers.platform) {
          if (event.modifiers.shift) window.focus_prev();
          else window.focus_next();
          cx.stop_propagation();
          return;
        }
        if (event.key !== 'escape' || this.saving) return;
        if (this.form) this.cancelForm(cx);
        else if (this.workItems.current && this.workItems.current.kind !== 'list' && this.workItemVisible(this.workItems.current)) {
          const ui = this.workItemViewProps();
          if (ui.screen?.archived) ui.actions.closeArchive(null, cx);
          else if (ui.screen?.form && !ui.mutation) ui.actions.cancelForm(null, cx);
          else this.backToWorkItems(cx, this.workItems.current);
        } else if (this.trail.length || this.workspaceReturn || this.selected) this.goBack(cx);
        else return;
        cx.stop_propagation();
      })
      .on_size_change((size, cx) => {
        const wide = size.width >= 670;
        const wideNavigation = size.width >= 800;
        if (wide === this.wide && wideNavigation === this.wideNavigation) return;
        this.wide = wide;
        this.wideNavigation = wideNavigation;
        cx.notify();
      })
      .child(header).child(body.child(this.renderContent(t, space)));
  }
}
