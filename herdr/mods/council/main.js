import { View, div } from 'gpui-kit';
import { Button, h_flex, v_flex, InputState } from 'gpui-base';
import { agents, appHome, checking, closeOverlay, exec, hc, notify, panes, props, readTextFile, run, spaces, terminals, theme } from 'herdr';
import { brandMark, button, cardHeading, columns, field, glyph, iconTile, input, label, panel, progress, reviewStatus, sectionTab, statusPill } from './components.js';
import { countLabel, decisionSummary, discussionType, invitation, pollStatus, projectLabels, projectName } from './poll-text.js';
import { pollParticipants, pollResults } from './poll-view.js';
import { delegationStatus, delegationView } from './delegation-view.js';
import { ballotBody, discussionView } from './discussion-view.js';
import { launcher, menu, sections } from './navigation.js';

const modes = [
  ['choice', 'Options'],
  ['mixed', 'Options + free'],
  ['open', 'Free response']
];

function localSpace() {
  return spaces().find(space => space.active);
}

function localProjects(active, allSpaces) {
  const localSpaces = allSpaces ? spaces().filter(space => !space.machine) : [active];
  const tabs = new Set(localSpaces.flatMap(space => space.tabs.map(tab => tab.id)));
  return [...new Set([...localSpaces.map(space => space.folder),
    ...panes().filter(pane => pane.terminal && tabs.has(pane.tab)).map(pane => pane.cwd)].filter(Boolean))];
}

function spaceRecipients(space) {
  const started = new Map(terminals().map(terminal => [terminal.address, terminal.created_ms]));
  return agents().filter(agent => agent.space === space?.id).map(agent => ({
    address: agent.address, label: agent.program?.name ?? agent.address, createdAt: started.get(agent.address)
  }));
}

const inviteStates = {
  queued: 'Waiting for terminal', sending: 'Checking terminal', uncertain: 'Delivery uncertain',
  alignment_required: 'Waiting for Council alignment', not_aligned: 'Council skill or integration missing',
  unavailable: 'Terminal unavailable', expired: 'Delivery window elapsed', cancelled: 'Invitation cancelled',
  dispatch_failed: 'Invitation worker stopped before sending'
};

function needsSetup(person) {
  return ['alignment_required', 'not_aligned'].some(state => state === person.state || state === person.reason);
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
        cx.open_url('https://github.com/ejupi-djenis30/council-herdr/blob/main/docs/alignment.md')))));
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
    this.tab = sections.find(section => section.id === options?.initialTab)?.id ?? 'polls';
    this.pollSection = 'results';
    this.listFilter = 'all';
    this.wide = false;
    this.folder = null;
    this.allSpaces = false;
    this.selected = null;
    this.form = null;
    this.config = null;
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

    if (checking()) return;
    this.panelFocus.focus();
    this.search = InputState.new({ placeholder: 'Search by title, project or ID' });
    this.search.on('change', (_e, cx) => cx.notify());
    this.reply = InputState.new({ placeholder: 'Write a reply…' });
    this.reply.on('change', (_e, cx) => cx.notify());
    this.reply.on('submit', (_e, cx) => this.replyToDebate(cx));
    cx.spawn(async cx => {
      try {
        const root = `${appHome()}/mods/council`;
        const raw = await readTextFile(`${root}/config.json`);
        const config = JSON.parse(raw ?? '{}');
        if (!config || (config.node !== undefined && (typeof config.node !== 'string' || !config.node.trim()))) {
          throw new Error('Council config.json needs a Node.js executable path.');
        }
        this.config = { node: config.node ?? 'node', entry: `${root}/runtime/council.mjs` };
        this.refresh(cx);
        cx.timer.every(5000, cx => this.refresh(cx));
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

  async request(folder, action, payload = {}) {
    let result;
    try {
      result = await exec(this.config.node, [this.config.entry, 'desktop', action, JSON.stringify(payload)], {
        cwd: folder, timeout: 10000
      });
    } catch (error) {
      throw new Error(`Council could not start its Node.js helper. ${error.message}`);
    }
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Council could not complete the request.');
    return JSON.parse(result.stdout);
  }

  navigate(cx, tab, selection = null) {
    const returningToList = this.tab === tab && this.selected && !selection;
    if (tab !== this.tab) this.clearFilters();
    this.pollSection = 'results';
    this.epoch++;
    this.loading = false;
    this.saving = false;
    this.selected = selection;
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

  clearFilters() {
    this.search?.set_value('');
    this.listFilter = 'all';
  }

  refresh(cx) {
    const space = localSpace();
    const folder = space?.machine ? null : space?.folder || null;
    if (folder !== this.folder) {
      this.folder = folder;
      this.clearFilters();
      this.navigate(cx, this.tab);
      return;
    }
    if (!folder || this.loading || this.saving) return;
    this.loading = true;
    const epoch = this.epoch;
    cx.spawn(async cx => {
      try {
        const selection = this.selected;
        const data = selection
          ? await this.request(selection.project, this.tab, { id: selection.id })
          : await this.request(folder, this.tab, { projects: localProjects(space, this.allSpaces) });
        if (epoch === this.epoch) {
          const changed = this.readError || JSON.stringify(data) !== JSON.stringify(this.data);
          this.readError = '';
          this.data = data;
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

  async launchInvitations(folder, payload) {
    const ticket = await this.request(folder, 'invite-prepare', payload);
    if (!ticket) return;
    try {
      const result = await hc(['run', '--bg', '--json', '--no-parent', '--no-notify', '--outlive-parent', '--rm', '--cwd', folder,
        '--', this.config.node, this.config.entry, 'invite', JSON.stringify(ticket)]);
      if (result.code !== 0 || !JSON.parse(result.stdout)?.address) throw new Error('Herdr did not confirm worker launch.');
    } catch {
      const disposition = await this.request(folder, 'invite-launch-failed', ticket).catch(() => null);
      const message = disposition?.recorded ? 'Herdr could not start the invitation worker. You can retry the unsent invites.'
        : 'Herdr did not confirm the invitation worker. Check the recorded delivery status before taking action.';
      throw new Error(message);
    }
  }

  invitationAction(cx, address, action) {
    const space = localSpace();
    const selection = this.selected;
    if (!space || !selection || this.saving || this.checkingInvitation) return;
    const params = { id: selection.id, space: space.id, address };
    const epoch = this.epoch;
    this.error = '';
    this.checkingInvitation = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        if (action === 'retry') {
          await this.launchInvitations(selection.project, params);
        } else {
          const result = await exec(this.config.node, [this.config.entry, 'invite-check', JSON.stringify(params)], {
            cwd: selection.project, timeout: 120000
          });
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
      canAct: !record.closedAt && record.invitationDelivery?.space === space?.id,
      disabled: this.saving || this.checkingInvitation,
      check: (cx, address) => this.invitationAction(cx, address, 'check'),
      retry: (cx, address) => this.invitationAction(cx, address, 'retry')
    });
  }

  replyToDebate(cx) {
    const debate = this.data?.debate;
    const text = this.reply?.value().trim();
    if (this.tab === 'debates' && debate?.interactive && text) this.save(cx, 'debate-reply', { id: debate.id, text });
  }

  save(cx, action, payload) {
    const space = localSpace();
    if (!this.folder || space?.machine || space?.folder !== this.folder || this.saving) return;
    const folder = this.selected?.project ?? this.folder;
    const creation = ['create', 'debate-create'].includes(action);
    const section = action.startsWith('debate-') ? 'debate' : 'poll';
    const recipients = creation ? spaceRecipients(space) : [];
    this.saving = true;
    this.loading = false;
    const epoch = ++this.epoch;
    this.error = '';
    cx.notify();
    cx.spawn(async cx => {
      try {
        const record = await this.request(folder, action, action === 'create' ? { ...payload, participants: recipients } : payload);
        let deliveryError = '';
        if (recipients.length) {
          try { await this.launchInvitations(folder, { id: record.id, space: space.id, recipients }); }
          catch (error) { deliveryError = `The ${section} opened. ${error.message}`; }
        }
        if (epoch !== this.epoch) return;
        this.selected = { id: record.id, project: folder };
        this.data = { ...this.data, [section]: record };
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
    this.copy(cx, invitation(poll, { folder: this.selected.project, cli: this.config.entry, participant }), 'Invitation copied.');
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

  focusAgent(cx, voter) {
    if (!this.visibleAgents(localSpace()).some(agent => agent.address === voter)) {
      this.error = 'That agent is no longer visible.';
      cx.notify();
      return;
    }
    run('agent.focus', { terminal: voter });
  }

  visibleAgents(space) {
    const ids = this.allSpaces ? spaces().filter(item => !item.machine).map(item => item.id) : [space?.id];
    return agents().filter(agent => ids.includes(agent.space));
  }

  pollCreator(poll, space) {
    if (!poll.createdBy) return '';
    if (poll.createdBy === 'operator') return 'Opened in Desktop';
    const agent = this.visibleAgents(space).find(agent => agent.address === poll.createdBy);
    return `Opened by ${agent?.program?.name ?? poll.createdBy}`;
  }

  startCreate(cx) {
    this.error = '';
    if (this.tab === 'debates') {
      this.setForm('create-debate', { question: '', context: '' });
      cx.notify();
      return;
    }
    this.setForm('create', { question: '', context: '' }, { mode: 'choice', options: [] });
    this.addDraftOption();
    this.addDraftOption();
    cx.notify();
  }

  addDraftOption() {
    const input = InputState.new();
    this.form.options.push(input);
    this.form.inputs.push(input);
  }

  renderCreate(t, space) {
    const form = this.form;
    const debate = form.kind === 'create-debate';
    const recipients = spaceRecipients(space).length;
    const fields = panel(t)
      .child(label(debate ? 'New debate' : 'New poll', 16, t.foreground).font_semibold())
      .child(field(t, debate ? 'Topic' : 'Question', form.question))
      .child(field(t, debate ? 'Opening message (optional)' : 'Context (optional)', form.context))
      .child(label(recipients ? `Automatically invites ${countLabel(recipients, 'agent')} in this space.`
        : 'There are no running agents in this space.', 12, t.muted));
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
    return fields.child(h_flex().gap(6).justify_end()
      .child(button(t, 'cancel-create', 'Cancel', (_e, cx) => this.cancelForm(cx), 'normal', this.saving))
      .child(button(t, 'create', debate ? 'Start debate' : 'Open poll', (_e, cx) => this.save(cx, debate ? 'debate-create' : 'create', {
        question: form.question.value(),
        context: form.context.value(),
        mode: form.mode,
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
        focus: (cx, voter) => this.focusAgent(cx, voter),
        track: (cx, participant) => this.save(cx, 'track', { id: poll.id, ...participant }),
        untrack: (cx, voter) => this.save(cx, 'untrack', { id: poll.id, voter })
      }, this.wide)
      : pollResults(t, poll, this.wide);
    return v_flex().w_full().gap(10).child(header.child(actions)).child(switchView).child(content);
  }

  renderReview(t, review) {
    const { tally, validation } = review;
    const card = panel(t)
      .child(h_flex().child(statusPill(t, reviewStatus(review.status), review.status === 'approved' ? t.done : t.muted)))
      .child(label(review.task, 17, t.foreground).font_semibold())
      .child(label(projectName(this.selected.project), 11, t.muted))
      .child(h_flex().child(button(t, 'open-debate', 'View discussion', (_e, cx) => this.navigate(cx, 'debates', this.selected), 'normal', false, 'debates')));
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
    if (validation?.verifiedSha256) card.child(h_flex().child(button(t, 'copy-sha', 'Copy proposal SHA', (_e, cx) =>
      this.copy(cx, validation.verifiedSha256, 'Proposal SHA copied.'), 'normal', false, 'copy')));
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
    const body = v_flex().w_full().min_w_0().gap(8)
      .child(h_flex().gap(6).flex_wrap().children([[false, 'This space'], [true, 'All local spaces']].map(([all, title]) =>
        button(t, `scope-${all}`, title, (_e, cx) => {
          if (all === this.allSpaces) return;
          this.allSpaces = all;
          this.navigate(cx, this.tab);
        }, this.allSpaces === all ? 'active' : 'normal'))));
    if (!items.length) {
      const empty = {
        polls: 'Polls opened by you or agents in these projects appear here.',
        delegations: 'Start a delegation with the Council CLI or MCP to follow it here.',
        debates: 'Start a thread with New debate. Formal reviews also appear here when they start.',
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
      const matchesQuery = [item.question, item.id, item.project, item.createdBy].some(value => value?.toLowerCase().includes(query));
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
      const metadata = isDelegations ? [item.agent ?? (item.ownership === 'borrowed' ? 'Existing terminal' : null), item.address].filter(Boolean).join(' · ')
        : !isPolls ? discussionType(item) : expected
          ? `${received}/${expected} tracked replied · ${countLabel(item.responseCount, 'response')}`
          : countLabel(item.responseCount, 'response');
      const origin = [origins.get(item.project), isPolls ? this.pollCreator(item, space) : null].filter(Boolean).join(' · ');
      return Button.new(`${item.project}/${item.id}`).w_full().min_w_0().px(12).py(11).rounded(9).items_center()
        .border_1().border_color(t.border).bg(t.surface).cursor_pointer()
        .accessibility_label([item.question, origin, metadata, status.title].filter(Boolean).join(', '))
        .tab_stop(true).focus(s => s.border_color(t.accent))
        .hover(s => s.bg(t.raised).border_color(t.input))
        .on_mouse_down('left', (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.navigate(cx, this.tab, { id: item.id, project: item.project }))
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
    if (space.machine) return panel(t).child(label('Council is available in local spaces.', 13, t.muted));
    if (space.folder !== this.folder || (!this.data && !this.readError)) return label('Loading project…', 12, t.muted);
    if (!this.data && this.readError) return div();
    if (['create', 'create-debate'].includes(this.form?.kind)) return this.renderCreate(t, space);
    if (this.selected) {
      const detail = this.data?.[this.tab.slice(0, -1)];
      if (!detail) return label('This item is unavailable.', 12, t.muted);
      if (this.tab === 'polls') return this.renderPoll(t, detail, space);
      if (this.tab === 'reviews') return this.renderReview(t, detail);
      if (this.tab === 'debates') return discussionView(t, detail, {
        project: projectName(this.selected.project),
        openReview: (_e, cx) => this.navigate(cx, 'reviews', this.selected),
        copy: (cx, value) => this.copy(cx, value, 'Contribution path copied.'),
        delivery: this.renderInvitations(t, detail, space),
        composer: detail.interactive ? h_flex().w_full().gap(8).items_center()
          .child(div().flex_1().min_w_0().child(input(t, this.reply).accessibility_label('Debate reply')))
          .child(button(t, 'post-reply', 'Reply', (_e, cx) => this.replyToDebate(cx), 'primary', this.saving || !this.reply.value().trim())) : null
      });
      return delegationView(t, detail, {
        wide: this.wide,
        terminal: this.visibleAgents(space).find(agent => agent.address === detail.address),
        focus: (cx, address) => this.focusAgent(cx, address),
        copy: (cx, value, title) => this.copy(cx, value, title)
      });
    }
    return this.renderList(t, space);
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
    const current = Boolean(this.config && !this.configError && space?.folder &&
      !space.machine && space.folder === this.folder);
    const tabs = h_flex().w_full().gap(4).p(3).rounded(9).border_1().border_color(t.border).bg(t.background)
      .role('tab_list').accessibility_label('Council sections').children(sections.map(({ id, title }, position) =>
        sectionTab(t, id, title, this.tab === id, (_e, cx) => {
          if (this.tab !== id) this.navigate(cx, id);
        }, this.saving).set_position(position + 1, sections.length)));
    const header = v_flex().flex_shrink_0().gap(12).p(14).bg(t.surface).border_b_1().border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(brandMark(40))
        .child(v_flex().flex_1().min_w_0().gap(2)
          .child(label('Council', 19, t.foreground).font_semibold())
          .when(Boolean(space?.folder), node => node.child(label(space.name || space.folder, 12, t.muted).truncate())))
        .when(current && ['polls', 'debates'].includes(this.tab) && !this.selected && !this.form, node =>
          node.child(button(t, 'new', this.tab === 'polls' ? 'New poll' : 'New debate', (_e, cx) => this.startCreate(cx), 'primary', false, 'add').track_focus(this.newFocus)))
        .when(current && Boolean(this.selected), node =>
          node.child(button(t, 'back', `All ${this.tab}`,
            (_e, cx) => this.navigate(cx, this.tab), 'normal', this.saving, 'back').track_focus(this.backFocus)))
        .when(Boolean(overlay), node =>
          node.child(button(t, 'dismiss-panel', '', () => closeOverlay(overlay), 'normal', false, 'close')
            .w(30).px(0).tooltip('Close Council').accessibility_label('Close Council'))))
      .child(tabs);
    const body = v_flex().id(`content-${this.tab}-${this.selected?.id ?? 'list'}-${this.form?.kind ?? this.pollSection}`)
      .flex_1().min_h(0).w_full().gap(10).p(14).overflow_y_scrollbar()
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation());
    if ((current || !this.config) && this.error) body.child(label(this.error, 12, t.blocked));
    if (current && this.readError) {
      body.child(h_flex().gap(8).items_center()
        .child(label(`Refresh failed. ${this.readError}`, 12, t.blocked).flex_1())
        .child(button(t, 'retry-read', 'Retry', (_e, cx) => this.refresh(cx))));
    }
    if (current && this.data?.errors?.length) {
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
        else if (this.selected) this.navigate(cx, this.tab);
        else return;
        cx.stop_propagation();
      })
      .on_size_change((size, cx) => {
        const wide = size.width >= 670;
        if (wide === this.wide) return;
        this.wide = wide;
        cx.notify();
      })
      .child(header).child(body.child(this.renderContent(t, space)));
  }
}
