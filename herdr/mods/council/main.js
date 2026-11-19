import { View, div } from 'gpui-kit';
import { h_flex, v_flex, InputState } from 'gpui-base';
import { agents, appHome, checking, closeOverlay, exec, notify, props, readTextFile, run, spaces, theme } from 'herdr';
import { brandMark, button, columns, field, input, label, panel, progress, reviewStatus, sectionTab, statusPill } from './components.js';
import { countLabel, decisionSummary, invitation, pollStatus } from './poll-text.js';
import { pollParticipants, pollResults } from './poll-view.js';

const modes = [
  ['choice', 'Options'],
  ['mixed', 'Options + free'],
  ['open', 'Free response']
];

function localSpace() {
  return spaces().find(space => space.active);
}

function spaceAgents(space) {
  return agents().filter(agent => agent.space === space?.id);
}

export default class Council extends View {
  init(_props, cx) {
    this.tab = 'polls';
    this.pollSection = 'results';
    this.pollFilter = 'all';
    this.wide = false;
    this.folder = null;
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

    if (checking()) return;
    this.search = InputState.new({ placeholder: 'Search by question or ID' });
    this.search.on('change', (_e, cx) => cx.notify());
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

  navigate(cx, tab, id = null) {
    if (tab !== this.tab) this.clearFilters();
    this.pollSection = 'results';
    this.epoch++;
    this.loading = false;
    this.saving = false;
    this.selected = id;
    this.tab = tab;
    this.data = null;
    this.error = '';
    this.readError = '';
    this.clearForm();
    this.refresh(cx);
    cx.notify();
  }

  clearFilters() {
    this.search?.set_value('');
    this.pollFilter = 'all';
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
        const data = await this.request(folder, this.tab, { id: this.selected });
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

  save(cx, action, payload) {
    const space = localSpace();
    if (!this.folder || space?.machine || space?.folder !== this.folder || this.saving) return;
    const folder = this.folder;
    this.saving = true;
    this.loading = false;
    const epoch = ++this.epoch;
    this.error = '';
    cx.notify();
    cx.spawn(async cx => {
      try {
        const poll = await this.request(folder, action, payload);
        if (epoch !== this.epoch) return;
        this.selected = poll.id;
        this.data = { ...this.data, poll };
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
    this.copy(cx, invitation(poll, { folder: this.folder, cli: this.config.entry, participant }), 'Invitation copied.');
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
    if (!spaceAgents(localSpace()).some(agent => agent.address === voter)) {
      this.error = 'That agent is no longer visible in this space.';
      cx.notify();
      return;
    }
    run('agent.focus', { terminal: voter });
  }

  startCreate(cx) {
    this.error = '';
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

  renderCreate(t) {
    const form = this.form;
    const fields = panel(t)
      .child(label('New poll', 16, t.foreground).font_semibold())
      .child(field(t, 'Question', form.question))
      .child(field(t, 'Context (optional)', form.context))
      .child(label('Response format', 11, t.muted))
      .child(h_flex().gap(5).flex_wrap().children(modes.map(([mode, title]) =>
        button(t, `mode-${mode}`, title, (_e, cx) => {
          form.mode = mode;
          cx.notify();
        }, mode === form.mode ? 'active' : 'normal', this.saving))));
    if (form.mode !== 'open') {
      fields.children(form.options.map((state, index) => h_flex().gap(8).items_end()
        .child(div().min_w_0().flex_1().child(field(t, `Option ${index + 1}`, state)))
        .when(form.options.length > 2, row => row.child(button(t, `remove-option-${index}`, 'Remove', (_e, cx) => {
          form.options.splice(index, 1);
          form.inputs = form.inputs.filter(input => input !== state);
          state.release();
          cx.notify();
        }, 'normal', this.saving).h(34)))))
        .child(h_flex().child(button(t, 'draft-option', '+ Add option', (_e, cx) => {
          this.addDraftOption();
          cx.notify();
        }, 'normal', this.saving || form.options.length >= 20)));
    }
    return fields.child(h_flex().gap(6).justify_end()
      .child(button(t, 'cancel-create', 'Cancel', (_e, cx) => { this.clearForm(); this.error = ''; cx.notify(); }, 'normal', this.saving))
      .child(button(t, 'create', 'Open poll', (_e, cx) => this.save(cx, 'create', {
        question: form.question.value(),
        context: form.context.value(),
        mode: form.mode,
        options: form.mode === 'open' ? [] : form.options.map(input => input.value()).filter(value => value.trim())
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
      .child(button(t, 'cancel-form', 'Cancel', (_e, cx) => { this.clearForm(); this.error = ''; cx.notify(); }, 'normal', this.saving))
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
      .when(Boolean(poll.context), node => node.child(label(poll.context, 13, t.muted)));
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
      }, 'primary', this.saving)).child(button(t, 'copy-invite', 'Copy invite', (_e, cx) => this.copyInvite(cx, poll)))
        .when(poll.mode !== 'open' && poll.options.length < 20, row => row.child(
          button(t, 'add-option', '+ Option', (_e, cx) => { this.setForm('option', { value: '' }); cx.notify(); }, 'normal', this.saving)))
        .child(button(t, 'close', 'Close poll', (_e, cx) => { this.setForm('close', { value: '' }); cx.notify(); }, 'normal', this.saving));
    }
    actions.child(button(t, 'copy-summary', poll.outcome ? 'Copy decision' : 'Copy results', (_e, cx) =>
      this.copy(cx, decisionSummary(poll, this.folder), 'Results copied.'), poll.closedAt ? 'primary' : 'normal'));

    const switchView = h_flex().gap(6)
      .child(button(t, 'poll-results', 'Results', (_e, cx) => this.selectPollSection(cx, 'results'),
        this.pollSection === 'results' ? 'active' : 'normal', this.saving))
      .child(button(t, 'poll-participants', expected && this.pollSection === 'results' ? `Participants · ${received}/${expected}` : 'Participants',
        (_e, cx) => this.selectPollSection(cx, 'participants'),
        this.pollSection === 'participants' ? 'active' : 'normal', this.saving));

    const content = this.pollSection === 'participants'
      ? pollParticipants(t, poll, spaceAgents(space), this.saving, {
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
      .child(label(reviewStatus(review.status), 11, review.status === 'approved' ? t.done : t.muted).font_semibold())
      .child(label(review.task, 17, t.foreground).font_semibold());
    if (!tally) return card.child(label('A saved verdict is required to show formal results.', 12, t.muted));
    const missing = Math.max(0, tally.expectedCount - tally.validCastCount - tally.invalidCount);
    const results = panel(t)
      .child(label('Direct ballots', 13, t.foreground).font_semibold())
      .child(label(`${tally.validCastCount}/${tally.expectedCount} valid · ${tally.quorumMet ? 'Quorum met' : 'Quorum unmet'}`, 12, t.muted))
      .child(progress(t, 'Approve', tally.approveCount, tally.expectedCount, t.done))
      .child(progress(t, 'Amend', tally.amendCount, tally.expectedCount, t.working))
      .child(progress(t, 'Reject', tally.rejectCount, tally.expectedCount, t.blocked))
      .when(tally.invalidCount > 0, node => node.child(label(countLabel(tally.invalidCount, 'invalid ballot'), 12, t.blocked)))
      .when(missing > 0, node => node.child(label(countLabel(missing, 'missing ballot'), 12, t.muted)));
    if (validation?.rationale) card.child(label(validation.rationale, 12, t.muted));
    for (const condition of validation?.conditions ?? []) card.child(label(`• ${condition}`, 12, t.foreground));
    if (validation?.verifiedSha256) card.child(h_flex().child(button(t, 'copy-sha', 'Copy proposal SHA', (_e, cx) =>
      this.copy(cx, validation.verifiedSha256, 'Proposal SHA copied.'))));
    if (review.reportPath) card.child(h_flex().child(button(t, 'copy-report', 'Copy report path', (_e, cx) =>
      this.copy(cx, review.reportPath, 'Report path copied.'))));
    for (const ballot of tally.sortedBallots ?? []) {
      const dissent = tally.dissent?.find(item => item.voter === ballot.voter);
      results.child(v_flex().gap(3).pt(7).border_t_1().border_color(t.border)
        .child(h_flex().justify_between().gap(6)
          .child(label(ballot.voter, 12, t.accent).font_semibold())
          .child(label(`${ballot.vote} · ${ballot.score}/10`, 12, t.muted)))
        .when(Boolean(dissent?.rationale), node => node.child(label(dissent.rationale, 12, t.muted)))
        .children((dissent?.amendments ?? []).map(amendment => label(`• ${amendment}`, 12, t.foreground))));
    }
    return columns(this.wide, card, results, 300);
  }

  renderList(t) {
    const isPolls = this.tab === 'polls';
    const items = this.data?.[this.tab] ?? [];
    if (!items.length) {
      return panel(t).child(label(isPolls ? 'No polls yet' : 'No reviews yet', 14, t.foreground).font_semibold())
        .child(label(isPolls
          ? 'Open a poll to gather choices or free responses from the agents in this project.'
          : 'Saved Council and review sessions for this project appear here.', 12, t.muted));
    }

    const query = this.search?.value().trim().toLowerCase() ?? '';
    const visible = items.filter(item => {
      const matchesQuery = item.question.toLowerCase().includes(query) || item.id.toLowerCase().includes(query);
      const matchesStatus = !isPolls || this.pollFilter === 'all' || (item.closedAt ? 'closed' : 'open') === this.pollFilter;
      return matchesQuery && matchesStatus;
    });
    const body = v_flex().w_full().min_w_0().gap(8).child(input(t, this.search));
    if (isPolls) {
      body.child(h_flex().gap(6).children([['all', 'All'], ['open', 'Open'], ['closed', 'Closed']].map(([id, title]) =>
        button(t, `filter-${id}`, title, (_e, cx) => {
          this.pollFilter = id;
          cx.notify();
        }, this.pollFilter === id ? 'active' : 'normal'))));
    }
    if (!visible.length) return body.child(panel(t)
      .child(label('No matches', 14, t.foreground).font_semibold())
      .child(h_flex().child(button(t, 'clear-filters', 'Clear filters', (_e, cx) => {
        this.clearFilters();
        cx.notify();
      }))));

    return body.children(visible.map(item => {
      const { expected, received } = item.participation ?? {};
      const status = isPolls ? pollStatus(item) : reviewStatus(item.status);
      const metadata = !isPolls ? item.mode : expected
        ? `${received}/${expected} tracked replied · ${countLabel(item.responseCount, 'response')}`
        : countLabel(item.responseCount, 'response');
      return panel(t).id(item.id).cursor_pointer().hover(s => s.bg(t.raised))
        .on_click((_e, cx) => this.navigate(cx, this.tab, item.id))
        .child(h_flex().justify_between().items_center().gap(6)
          .child(statusPill(t, status, (isPolls ? !item.closedAt : item.status === 'approved') ? t.done : t.muted))
          .child(label(metadata, 11, t.muted)))
        .child(label(item.question, 15, t.foreground).font_medium());
    }));
  }

  renderContent(t, space) {
    if (this.configError) return label(this.configError, 13, t.blocked);
    if (!space?.folder) return panel(t).child(label('Open a Herdr space with a project folder.', 13, t.muted));
    if (space.machine) return panel(t).child(label('Council polls and reviews are available in local spaces.', 13, t.muted));
    if (space.folder !== this.folder || (!this.data && !this.readError)) return label('Loading project…', 12, t.muted);
    if (!this.data && this.readError) return div();
    if (this.form?.kind === 'create') return this.renderCreate(t);
    if (this.selected) {
      const detail = this.tab === 'polls' ? this.data?.poll : this.data?.review;
      if (!detail) return label('This item is unavailable.', 12, t.muted);
      return this.tab === 'polls' ? this.renderPoll(t, detail, space) : this.renderReview(t, detail);
    }
    return this.renderList(t);
  }

  render() {
    const t = theme();
    const space = localSpace();
    const overlay = props()?.overlay;
    const current = Boolean(this.config && !this.configError && space?.folder &&
      !space.machine && space.folder === this.folder);
    const tabs = h_flex().gap(6).children([['polls', 'Polls'], ['reviews', 'Reviews']].map(([id, title]) =>
      sectionTab(t, id, title, this.tab === id, (_e, cx) => this.navigate(cx, id), this.saving)));
    const header = v_flex().flex_shrink_0().gap(12).p(14).border_b_1().border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(brandMark(t))
        .child(v_flex().flex_1().min_w_0().gap(1)
          .child(label('Council', 18, t.foreground).font_semibold())
          .when(Boolean(space?.folder), node => node.child(label(space.name || space.folder, 11, t.muted).truncate())))
        .when(current && this.tab === 'polls' && !this.selected && !this.form, node =>
          node.child(button(t, 'new', '+ New poll', (_e, cx) => this.startCreate(cx), 'primary')))
        .when(Boolean(overlay), node =>
          node.child(button(t, 'dismiss-panel', 'Close panel', () => closeOverlay(overlay)))))
      .child(tabs);
    const body = v_flex().id(`content-${this.tab}-${this.selected ?? 'list'}-${this.form?.kind ?? this.pollSection}`)
      .flex_1().min_h(0).w_full().gap(10).p(14).overflow_y_scrollbar()
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation());
    if (current && this.selected) {
      body.child(h_flex().child(button(t, 'back', this.tab === 'polls' ? '‹ All polls' : '‹ All reviews',
        (_e, cx) => this.navigate(cx, this.tab))));
    }
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
      .on_size_change((size, cx) => {
        const wide = size.width >= 670;
        if (wide === this.wide) return;
        this.wide = wide;
        cx.notify();
      })
      .child(header).child(body.child(this.renderContent(t, space)));
  }
}
