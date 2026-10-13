// ==UserScript==
// @name         MyTimeLogger
// @namespace    https://efrag.myprotime.eu/
// @version      0.2.0
// @description  Bulk day status and project time logging for myProtime
// @match        https://efrag.myprotime.eu/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const APP_ID = 'mytimelogger';
  const TOGGLE_EVENT = 'mytimelogger:toggle';
  const WORKING_TYPE_ID = 3245;
  const WORKING_TYPE_IDS = new Set([WORKING_TYPE_ID, 3609, 3610, 5743]);
  const VACATION_TYPE = { id: 3210, name: 'Vacation' };
  const DURATION_TYPES = [['FullDay', 'Full day'], ['FirstDayPart', 'First day part'], ['SecondDayPart', 'Second day part']];
  const TOKEN_MAX_AGE_MS = 10 * 60 * 1000;
  const ABSENCE_RETRY_DELAY_MS = 1500;
  const ABSENCE_MAX_RETRIES = 10;
  const MAX_RANGE_DAYS = 62;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const pad = n => String(n).padStart(2, '0');
  const toIso = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const fromIso = iso => new Date(`${iso}T00:00:00Z`);
  const addDays = (iso, n) => { const d = fromIso(iso); d.setUTCDate(d.getUTCDate() + n); return toIso(d); };
  const toDmy = iso => iso.split('-').reverse().join('/');
  const isWeekend = iso => [0, 6].includes(fromIso(iso).getUTCDay());
  const mondayOf = iso => addDays(iso, -((fromIso(iso).getUTCDay() + 6) % 7));
  const formatDay = iso => fromIso(iso).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });

  function todayIso() {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function datesBetween(from, to) {
    if (!from || !to) throw new Error('Please enter both dates');
    if (from > to) throw new Error('"From" must not be after "To"');
    const dates = [];
    for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
    if (dates.length > MAX_RANGE_DAYS) throw new Error(`Please choose at most ${MAX_RANGE_DAYS} days`);
    return dates;
  }

  function normalizeDuration(text) {
    const value = text.trim();
    if (/^\d+([.,]\d+)?$/.test(value)) {
      const minutes = Math.round(parseFloat(value.replace(',', '.')) * 60);
      return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`;
    }
    const match = /^(\d{1,2}):([0-5]\d)$/.exec(value);
    if (!match) throw new Error(`Invalid hours "${text}" – use h:mm (7:30) or decimal hours (7.5)`);
    return `${Number(match[1])}:${match[2]}`;
  }

  const api = {
    bearer: null,
    bearerFetchedAt: 0,

    async authorization(forceRefresh) {
      if (forceRefresh || !this.bearer || Date.now() - this.bearerFetchedAt > TOKEN_MAX_AGE_MS) {
        const response = await fetch('/api/auth/token', { credentials: 'include' });
        if (!response.ok) throw new Error(`Could not get an access token (${response.status}) – are you logged in?`);
        this.bearer = (await response.text()).trim().replace(/^"|"$/g, '');
        this.bearerFetchedAt = Date.now();
      }
      return this.bearer;
    },

    xsrfToken() {
      const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    },

    async send(method, path, { json, form } = {}, isRetry = false) {
      const headers = {
        Accept: form ? 'multipart/form-data' : 'application/json',
        authorization: await this.authorization(isRetry),
        'x-xsrf-token': this.xsrfToken(),
      };
      let body;
      if (json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(json);
      } else if (form !== undefined) {
        body = new FormData();
        body.append('model', JSON.stringify(form));
      }
      const response = await fetch(path, { method, headers, body, credentials: 'include' });
      if (response.status === 401 && !isRetry) return this.send(method, path, { json, form }, true);
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${response.statusText} ${text.slice(0, 200)}`.trim());
      return text ? JSON.parse(text) : null;
    },

    get(path) { return this.send('GET', path); },
    post(path, payload) { return this.send('POST', path, payload); },
  };

  const protime = {
    personId: null,
    personName: '',

    async loadPerson() {
      const me = await api.get('/api/users/me?include=person');
      this.personId = me.data.relationships.person.data.id;
      this.personName = me.data.attributes.name;
    },

    async loadProjects(iso) {
      const date = encodeURIComponent(toDmy(iso));
      const form = await api.post(`/bff/cost/form_fields/${this.personId}?date=${date}&poll=0`, {
        json: { costLevelsKey: [], searchBy: [], changeContext: { changedProp: 'none' }, usageContext: 'duration' },
      });
      const level = form.levels[0];
      const all = [...level.costDefinitions];
      let hasMore = all.length > 0;
      while (hasMore) {
        const lastId = all[all.length - 1].id;
        const page = await api.get(`/bff/cost/form_fields/${this.personId}/search_definitions?query=&searchBy=Name&date=${date}`
          + `&levelIndex=1&costLevelsKey=noDefinitionSelected&lastLoadedDefinitionId=${lastId}&usageContext=duration`);
        const unseen = page.costDefinitions.filter(definition => !all.some(known => known.id === definition.id));
        all.push(...unseen);
        hasMore = page.hasMoreResults && unseen.length > 0;
      }
      return {
        favourites: level.favouriteCostDefinitions ?? [],
        recent: level.mostRecentCostDefinitions ?? [],
        all,
      };
    },

    async loadAbsenceTypes(iso) {
      const date = toDmy(iso);
      const form = await api.get(`/api/absencerequest/form?personId=${this.personId}&from=${date}&until=${date}&absenceRequestId=undefined&poll=0`);
      const types = form.absenceDefinitions.map(definition => ({ id: definition.reference, name: definition.friendlyNameWithBalance }));
      if (!types.some(type => type.id === VACATION_TYPE.id)) types.unshift(VACATION_TYPE);
      return types;
    },

    async loadDay(iso) {
      const detail = await api.get(`/api/daydetail/person/${this.personId}?date=${iso}&poll=0`);
      const costDurations = detail.costDurations?.costDurations ?? [];
      return {
        date: iso,
        statuses: detail.dayEvents
          .filter(event => event.group !== 'Allowance')
          .map(event => ({ id: event.dayEventId, title: event.title, detail: event.detail })),
        entries: costDurations
          .filter(entry => !entry.removalRequestId)
          .map(entry => ({ name: entry.displayName, duration: entry.duration })),
        totalDuration: detail.costDurations?.totalDuration ?? '',
        scheduledDuration: detail.presenceModel?.normalTime || '',
        isPublicHoliday: Boolean(detail.indicators?.isPublicHoliday),
        isLocked: Boolean(detail.indicators?.isLocked),
      };
    },

    async loadCostEntries(iso) {
      const list = await api.get(`/bff/cost/cost_duration_request/person/${this.personId}/list?date=${toDmy(iso)}&poll=0`);
      return list.durationsByDefinition.flatMap(group => group.details
        .filter(detail => detail.listItemType === 'CostDuration' && detail.costDurationId)
        .map(detail => ({ id: detail.costDurationId, name: group.displayName, duration: detail.duration })));
    },

    addCost(iso, projectId, duration) {
      return api.post('/bff/cost/cost_duration_request/request/add', {
        json: { date: toDmy(iso), costDefinitionId: null, costDefinitionIds: [projectId], duration, comment: null, subject: this.personId, requestId: '' },
      });
    },

    removeCost(costDurationId) {
      return api.post('/bff/cost/cost_duration_removal_request/request/add', {
        json: { requestId: costDurationId, subject: this.personId },
      });
    },

    async requestStatus(iso, typeId, durationType) {
      const firstSave = Date.now();
      let result = await api.post('/api/absencerequest/save', {
        form: { absenceDefinitionId: typeId, durationType, startDate: toDmy(iso), endDate: toDmy(iso), comment: '', personId: this.personId, attachmentIds: [] },
      });
      const absenceRequestId = result.requestId;
      for (let retryNr = 0; !result.completed && retryNr < ABSENCE_MAX_RETRIES; retryNr++) {
        await sleep(ABSENCE_RETRY_DELAY_MS);
        result = await api.post('/api/absencerequest/save-retry', {
          form: { absenceRequestId, personId: this.personId, timestampNow: Date.now(), timestampFirstSave: firstSave, retryNr, isLastRetry: retryNr === ABSENCE_MAX_RETRIES - 1 },
        });
      }
      if (result.isDeniedByCredit) throw new Error('Denied: insufficient balance');
      if (!result.completed) throw new Error('ProTime did not confirm the request in time – check the calendar');
    },

    removeStatus(iso, typeId) {
      return api.post('/api/absence/detail/remove', {
        json: { subjectId: this.personId, definitionId: typeId, date: toDmy(iso), comment: '' },
      });
    },
  };

  class Plan {
    constructor() { this.rows = []; }
    add(date, description, run) { this.rows.push({ date, description, run }); }
    skip(date, reason) { this.rows.push({ date, description: reason, skipped: true }); }
    get actions() { return this.rows.filter(row => !row.skipped); }
  }

  const describeStatuses = day => day.statuses.map(status => status.title).join(', ');
  const describeEntries = day => day.entries.map(entry => `${entry.name} ${entry.duration}`).join('; ');

  async function forEachDay(dates, onProgress, visit) {
    for (const [index, date] of dates.entries()) {
      onProgress(`Reading ${formatDay(date)} (${index + 1}/${dates.length})…`);
      await visit(date);
    }
  }

  async function prepareWorkingDay(plan, date, { setWorking, replace }) {
    if (isWeekend(date)) return plan.skip(date, 'Weekend');
    const day = await protime.loadDay(date);
    if (day.isPublicHoliday) return plan.skip(date, 'Public holiday');
    if (day.isLocked) return plan.skip(date, 'Day is locked');

    const isWorking = day.statuses.some(status => WORKING_TYPE_IDS.has(status.id));
    if (!isWorking && day.statuses.length > 0) return plan.skip(date, `Not working: ${describeStatuses(day)}`);
    if (!isWorking && !setWorking) return plan.skip(date, 'No status set');
    if (day.entries.length > 0 && !replace) return plan.skip(date, `Already logged: ${describeEntries(day)}`);

    if (!isWorking) plan.add(date, 'Set status: Working', () => protime.requestStatus(date, WORKING_TYPE_ID, 'FullDay'));
    if (day.entries.length > 0) await addCostRemovals(plan, date);
    return day;
  }

  async function addCostRemovals(plan, date) {
    const entries = await protime.loadCostEntries(date);
    for (const entry of entries) {
      plan.add(date, `Delete ${entry.name} ${entry.duration}`, () => protime.removeCost(entry.id));
    }
    return entries.length;
  }

  async function planDeleteActivities({ from, to, removeStatus }, onProgress) {
    const plan = new Plan();
    await forEachDay(datesBetween(from, to), onProgress, async date => {
      const day = await protime.loadDay(date);
      if (day.isLocked) return plan.skip(date, 'Day is locked');
      const removals = day.entries.length > 0 ? await addCostRemovals(plan, date) : 0;
      const statuses = removeStatus ? day.statuses : [];
      for (const status of statuses) {
        plan.add(date, `Remove status: ${status.title}`, () => protime.removeStatus(date, status.id));
      }
      if (removals === 0 && statuses.length === 0) plan.skip(date, isWeekend(date) ? 'Weekend – nothing logged' : 'Nothing to delete');
    });
    return plan;
  }

  async function planLogRange({ from, to, project, duration, setWorking, replace }, onProgress) {
    if (!project) throw new Error('Please choose a project');
    const plan = new Plan();
    await forEachDay(datesBetween(from, to), onProgress, async date => {
      const day = await prepareWorkingDay(plan, date, { setWorking, replace });
      if (!day) return;
      const hours = duration || day.scheduledDuration;
      if (!hours) return plan.skip(date, 'No scheduled hours – enter hours per day');
      plan.add(date, `Log ${hours} → ${project.name}`, () => protime.addCost(date, project.id, hours));
    });
    return plan;
  }

  async function planCopyDay({ source, from, to, projectsByName, setWorking, replace }, onProgress) {
    if (!source) throw new Error('Please choose the day to copy');
    onProgress(`Reading ${formatDay(source)}…`);
    const sourceDay = await protime.loadDay(source);
    if (sourceDay.entries.length === 0) throw new Error(`${formatDay(source)} has no logged time to copy`);
    const entries = sourceDay.entries.map(entry => {
      const project = projectsByName.get(entry.name);
      if (!project) throw new Error(`Project "${entry.name}" is not in your project list`);
      return { project, duration: entry.duration };
    });

    const plan = new Plan();
    const targets = datesBetween(from, to).filter(date => date !== source);
    await forEachDay(targets, onProgress, async date => {
      const day = await prepareWorkingDay(plan, date, { setWorking, replace });
      if (!day) return;
      for (const { project, duration } of entries) {
        plan.add(date, `Log ${duration} → ${project.name}`, () => protime.addCost(date, project.id, duration));
      }
    });
    return plan;
  }

  async function planStatus({ from, to, type, durationType, replace }, onProgress) {
    const plan = new Plan();
    await forEachDay(datesBetween(from, to), onProgress, async date => {
      if (isWeekend(date)) return plan.skip(date, 'Weekend');
      const day = await protime.loadDay(date);
      if (day.isPublicHoliday) return plan.skip(date, 'Public holiday');
      if (day.isLocked) return plan.skip(date, 'Day is locked');
      if (day.statuses.some(status => status.id === type.id)) return plan.skip(date, `Already: ${type.name}`);
      if (day.statuses.length > 0 && !replace) return plan.skip(date, `Has status: ${describeStatuses(day)}`);

      for (const status of day.statuses) {
        plan.add(date, `Remove status: ${status.title}`, () => protime.removeStatus(date, status.id));
      }
      plan.add(date, `Set status: ${type.name}`, () => protime.requestStatus(date, type.id, durationType));
    });
    return plan;
  }

  async function loadOverview({ from, to }, onProgress) {
    const days = [];
    await forEachDay(datesBetween(from, to), onProgress, async date => { days.push(await protime.loadDay(date)); });
    return days;
  }

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: Segoe UI, Roboto, Arial, sans-serif; font-size: 13px; }
    .launcher { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; padding: 10px 16px; border: 0; border-radius: 20px;
      background: #1f5fa8; color: #fff; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
    .launcher:hover { background: #174a85; }
    .panel { position: fixed; right: 20px; bottom: 70px; z-index: 2147483000; width: min(620px, calc(100vw - 40px)); max-height: calc(100vh - 100px);
      display: flex; flex-direction: column; background: #fff; color: #222; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.3); }
    .panel[hidden] { display: none; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #e3e3e3; }
    header h1 { margin: 0; font-size: 15px; flex: 1; }
    header .person { color: #666; }
    .close { border: 0; background: none; font-size: 18px; cursor: pointer; color: #666; }
    nav { display: flex; border-bottom: 1px solid #e3e3e3; }
    nav button { flex: 1; padding: 8px; border: 0; border-bottom: 2px solid transparent; background: none; cursor: pointer; color: #444; }
    nav button.active { border-bottom-color: #1f5fa8; color: #1f5fa8; font-weight: 600; }
    .body { padding: 12px 14px; overflow: auto; }
    .fields { display: grid; grid-template-columns: 110px 1fr; gap: 8px 10px; align-items: center; }
    .fields .full { grid-column: 1 / -1; }
    .fields p { margin: 0; }
    input[type=date], input[type=text], select { width: 100%; padding: 5px 6px; border: 1px solid #bbb; border-radius: 4px; background: #fff; color: #222; }
    label.check { display: flex; gap: 6px; align-items: center; }
    .actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
    .primary, .secondary { padding: 7px 14px; border-radius: 4px; cursor: pointer; border: 1px solid #1f5fa8; }
    .primary { background: #1f5fa8; color: #fff; }
    .secondary { background: #fff; color: #1f5fa8; }
    button:disabled { opacity: .5; cursor: default; }
    .message { color: #555; }
    .message.error { color: #b00020; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
    th { color: #666; font-weight: 600; }
    tr.skipped td { color: #999; }
    td.state { white-space: nowrap; }
    td.state.ok { color: #1b7f3b; }
    td.state.failed { color: #b00020; }
    .nowrap { white-space: nowrap; }
  `;

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node[key] = value;
    }
    node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
    return node;
  }

  const dateInput = value => h('input', { type: 'date', value });
  const checkbox = checked => h('input', { type: 'checkbox', checked });
  const field = (label, input) => [h('label', {}, label), input];
  const checkField = (input, label) => h('label', { className: 'check full' }, input, label);
  const options = items => items.map(([value, label]) => h('option', { value }, label));

  function projectSelect(projects) {
    const group = (label, items) => h('optgroup', { label }, options(items.map(project => [project.id, project.name])));
    return h('select', {},
      h('option', { value: '' }, '— choose a project —'),
      projects.favourites.length ? group('Favourites', projects.favourites) : null,
      projects.recent.length ? group('Recently used', projects.recent) : null,
      group('All projects', projects.all));
  }

  function buildTabs(context) {
    const today = todayIso();
    const monday = mondayOf(today);
    const friday = addDays(monday, 4);

    const overviewFrom = dateInput(monday), overviewTo = dateInput(addDays(monday, 6));

    const logFrom = dateInput(monday), logTo = dateInput(friday);
    const logProject = projectSelect(context.projects);
    const logHours = h('input', { type: 'text', placeholder: 'empty = scheduled hours (e.g. 8:00)' });
    const logSetWorking = checkbox(true), logReplace = checkbox(false);

    const copySource = dateInput(today), copyFrom = dateInput(addDays(today, 1));
    const copyTo = dateInput(friday > today ? friday : addDays(today, 1));
    const copySetWorking = checkbox(true), copyReplace = checkbox(false);

    const statusFrom = dateInput(monday), statusTo = dateInput(friday);
    const statusType = h('select', {}, options(context.absenceTypes.map(type => [type.id, type.name])));
    statusType.value = String(WORKING_TYPE_ID);
    const statusDuration = h('select', {}, options(DURATION_TYPES));
    const statusReplace = checkbox(false);

    const deleteFrom = dateInput(monday), deleteTo = dateInput(friday);
    const deleteStatus = checkbox(false);

    const setWorkingLabel = 'Set status "Working" on weekdays that have no status yet';
    const replaceLabel = 'Replace time already logged (otherwise those days are skipped)';

    return [
      {
        title: 'Overview',
        fields: [...field('From', overviewFrom), ...field('To', overviewTo)],
        buttonLabel: 'Show',
        view: onProgress => loadOverview({ from: overviewFrom.value, to: overviewTo.value }, onProgress),
      },
      {
        title: 'Log range',
        fields: [...field('From', logFrom), ...field('To', logTo), ...field('Project', logProject), ...field('Hours per day', logHours),
          checkField(logSetWorking, setWorkingLabel), checkField(logReplace, replaceLabel)],
        buttonLabel: 'Preview',
        plan: onProgress => planLogRange({
          from: logFrom.value, to: logTo.value,
          project: context.projectsById.get(logProject.value),
          duration: logHours.value.trim() ? normalizeDuration(logHours.value) : null,
          setWorking: logSetWorking.checked, replace: logReplace.checked,
        }, onProgress),
      },
      {
        title: 'Copy day',
        fields: [...field('Copy day', copySource), ...field('To days from', copyFrom), ...field('until', copyTo),
          checkField(copySetWorking, setWorkingLabel), checkField(copyReplace, replaceLabel)],
        buttonLabel: 'Preview',
        plan: onProgress => planCopyDay({
          source: copySource.value, from: copyFrom.value, to: copyTo.value,
          projectsByName: context.projectsByName,
          setWorking: copySetWorking.checked, replace: copyReplace.checked,
        }, onProgress),
      },
      {
        title: 'Day status',
        fields: [...field('From', statusFrom), ...field('To', statusTo), ...field('Status', statusType), ...field('Duration', statusDuration),
          checkField(statusReplace, 'Replace an existing status (e.g. Working → Vacation)')],
        buttonLabel: 'Preview',
        plan: onProgress => planStatus({
          from: statusFrom.value, to: statusTo.value,
          type: context.absenceTypes.find(type => String(type.id) === statusType.value),
          durationType: statusDuration.value, replace: statusReplace.checked,
        }, onProgress),
      },
      {
        title: 'Delete',
        fields: [...field('From', deleteFrom), ...field('To', deleteTo),
          h('p', { className: 'full message' }, 'Deletes all logged project time (activities) of every day in the range.'),
          checkField(deleteStatus, 'Also remove the day status (Working, Vacation, …)')],
        buttonLabel: 'Preview',
        plan: onProgress => planDeleteActivities({ from: deleteFrom.value, to: deleteTo.value, removeStatus: deleteStatus.checked }, onProgress),
      },
    ];
  }

  function overviewTable(days) {
    return h('table', {},
      h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Status'), h('th', {}, 'Logged'), h('th', {}, 'Total')),
      days.map(day => h('tr', {},
        h('td', { className: 'nowrap' }, formatDay(day.date)),
        h('td', {}, day.isPublicHoliday ? 'Public holiday' : describeStatuses(day) || '—'),
        h('td', {}, day.entries.map(entry => h('div', {}, `${entry.name} ${entry.duration}`))),
        h('td', {}, day.totalDuration))));
  }

  function planTable(plan) {
    const stateCells = new Map();
    const table = h('table', {},
      h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Action'), h('th', {}, '')),
      plan.rows.map(row => {
        const state = h('td', { className: 'state' }, row.skipped ? 'skipped' : 'planned');
        stateCells.set(row, state);
        return h('tr', { className: row.skipped ? 'skipped' : '' },
          h('td', { className: 'nowrap' }, formatDay(row.date)), h('td', {}, row.description), state);
      }));
    return { table, stateCells };
  }

  function createApp() {
    const host = h('div', { id: APP_ID });
    const root = host.attachShadow({ mode: 'open' });
    host.addEventListener(TOGGLE_EVENT, toggle);
    document.body.append(host);

    const panel = h('div', { className: 'panel', hidden: true });
    root.append(h('style', {}, STYLE), h('button', { className: 'launcher', onclick: toggle }, 'Time Logger'), panel);
    let initialized = false;

    async function toggle() {
      panel.hidden = !panel.hidden;
      if (panel.hidden || initialized) return;
      initialized = true;
      panel.replaceChildren(h('div', { className: 'body message' }, 'Loading your projects and absence types…'));
      try {
        panel.replaceChildren(...render(await loadContext()));
      } catch (error) {
        initialized = false;
        panel.replaceChildren(h('div', { className: 'body message error' }, `Could not start: ${error.message}`));
      }
    }

    async function loadContext() {
      await protime.loadPerson();
      const today = todayIso();
      const [projects, absenceTypes] = await Promise.all([protime.loadProjects(today), protime.loadAbsenceTypes(today)]);
      const known = [...projects.all, ...projects.favourites, ...projects.recent];
      return {
        projects,
        absenceTypes,
        projectsById: new Map(known.map(project => [project.id, project])),
        projectsByName: new Map(known.map(project => [project.name, project])),
      };
    }

    function render(context) {
      const tabs = buildTabs(context);
      const tabButtons = tabs.map((tab, index) => h('button', { onclick: () => select(index) }, tab.title));
      const body = h('div', { className: 'body' });
      const header = h('header', {},
        h('h1', {}, 'MyTimeLogger'), h('span', { className: 'person' }, protime.personName),
        h('button', { className: 'close', title: 'Close', onclick: () => { panel.hidden = true; } }, '×'));

      function select(index) {
        tabButtons.forEach((button, i) => button.classList.toggle('active', i === index));
        body.replaceChildren(...renderTab(tabs[index]));
      }

      select(0);
      return [header, h('nav', {}, tabButtons), body];
    }

    function renderTab(tab) {
      const message = h('span', { className: 'message' });
      const result = h('div');
      const goButton = h('button', { className: 'secondary', onclick: run }, tab.buttonLabel);

      const showMessage = (text, isError = false) => {
        message.textContent = text;
        message.classList.toggle('error', isError);
      };

      async function run() {
        goButton.disabled = true;
        result.replaceChildren();
        try {
          if (tab.view) {
            result.append(overviewTable(await tab.view(showMessage)));
            showMessage('');
          } else {
            showPlan(await tab.plan(showMessage));
          }
        } catch (error) {
          showMessage(error.message, true);
        } finally {
          goButton.disabled = false;
        }
      }

      function showPlan(plan) {
        const count = plan.actions.length;
        if (count === 0) {
          showMessage('Nothing to do.');
          result.append(planTable(plan).table);
          return;
        }
        const { table, stateCells } = planTable(plan);
        const executeButton = h('button', { className: 'primary' }, `Execute ${count} action${count === 1 ? '' : 's'}`);
        executeButton.addEventListener('click', () => execute(plan, stateCells, executeButton));
        showMessage('Check the actions below, then execute. Review the result in myProtime afterwards.');
        result.append(h('div', { className: 'actions' }, executeButton), table);
      }

      async function execute(plan, stateCells, executeButton) {
        executeButton.disabled = true;
        goButton.disabled = true;
        let failed = 0;
        for (const [index, action] of plan.actions.entries()) {
          const cell = stateCells.get(action);
          cell.textContent = 'running…';
          showMessage(`Executing ${index + 1}/${plan.actions.length}…`);
          try {
            await action.run();
            cell.textContent = '✓ done';
            cell.className = 'state ok';
          } catch (error) {
            failed++;
            cell.textContent = `✗ ${error.message}`;
            cell.className = 'state failed';
          }
        }
        goButton.disabled = false;
        const outcome = failed ? `Finished with ${failed} failed action(s).` : 'All actions done.';
        showMessage(`${outcome} Please review the result in the myProtime calendar.`, failed > 0);
      }

      return [h('div', { className: 'fields' }, tab.fields), h('div', { className: 'actions' }, goButton, message), result];
    }
  }

  if (!document.getElementById(APP_ID)) createApp();
})();
