import { t } from "./i18n.js";
import { api, button, closeDialog, copyField, el, field, form, identifier, localizedTime, notify, openDirect, personRow, select, showDialog, status, tell } from "./ui.js";

const relationships = {
  friend: ["Friend", "Befreundet"],
  incoming: ["Incoming request", "Offene Anfrage"],
  outgoing: ["Request sent", "Angefragt"],
};

function peopleList(label) {
  return el("ul", { class: "person-list people-list", tabindex: "0", "aria-label": label });
}

export async function renderFriends({ signal }) {
  const initial = await api("people", { signal });
  const input = el("input", {
    type: "search", name: "search", placeholder: t("Name or username", "Name oder Benutzername"),
    maxlength: "64", autocomplete: "off",
  });
  const resultList = peopleList(t("Search results", "Suchergebnisse"));
  const results = el("div", { class: "search-results", hidden: true }, el("h3", {}, t("Search results", "Suchergebnisse")), resultList);
  const friendsList = peopleList(t("Your friends", "Deine Freunde"));
  const requestsList = peopleList(t("Requests", "Anfragen"));
  const feedback = status();
  let query = "";

  async function updatePeople() {
    const list = await api("people", { signal });
    updateOverview(list.people ?? []);
    if (query) {
      const found = await api("people?query=" + encodeURIComponent(query), { signal });
      updateResults(found.people ?? []);
    }
  }

  function action(person, name, label, classes = "") {
    return button(label, async event => {
      const control = event.currentTarget;
      control.disabled = true;
      tell(feedback, "");
      try {
        await api("friends/" + identifier(person.id), { method: "POST", body: { action: name }, signal });
        await updatePeople();
      } catch (error) {
        if (!signal.aborted) tell(feedback, error.message, "error");
      } finally {
        control.disabled = false;
      }
    }, { class: classes });
  }

  function friendlyRow(person) {
    let controls;
    if (person.relationship === "incoming") {
      controls = [
        action(person, "accept", t("Accept", "Annehmen"), "primary"),
        action(person, "remove", t("Decline", "Ablehnen")),
      ];
    } else if (person.relationship === "outgoing") {
      controls = [action(person, "remove", t("Withdraw", "Zurückziehen"))];
    } else if (person.relationship === "friend") {
      controls = [button(t("Message", "Nachricht"), async event => {
        const control = event.currentTarget;
        control.disabled = true;
        try {
          await openDirect(person.id, signal);
        } catch (error) {
          if (!signal.aborted) tell(feedback, error.message, "error");
        } finally {
          control.disabled = false;
        }
      }), action(person, "remove", t("Remove", "Entfernen"), "danger")];
    } else {
      controls = [action(person, "request", t("Add friend", "Freund hinzufügen"), "primary")];
    }
    const relationship = Object.hasOwn(relationships, person.relationship) && relationships[person.relationship];
    return personRow(person, controls, relationship ? t(...relationship) : "");
  }

  function populate(list, people, emptyMessage) {
    list.replaceChildren(...(people.length ? people.map(friendlyRow) : [el("li", { class: "muted" }, emptyMessage)]));
    list.tabIndex = people.length ? 0 : -1;
  }

  function updateResults(people) {
    populate(resultList, people, t("No matching members found.", "Keine passenden Mitglieder gefunden."));
    results.hidden = false;
  }

  function updateOverview(people) {
    const friends = people.filter(item => item.relationship === "friend");
    const requests = people.filter(item => item.relationship === "incoming" || item.relationship === "outgoing");
    populate(friendsList, friends, t("Your confirmed friends will appear here.", "Hier erscheinen deine bestätigten Freundschaften."));
    populate(requestsList, requests, t("You have no pending requests.", "Du hast keine offenen Anfragen."));
  }

  updateOverview(initial.people ?? []);
  const views = [
    ["friends", t("Your friends", "Deine Freunde")], ["requests", t("Requests", "Anfragen")], ["search", t("Search", "Suchen")],
  ];
  return el("div", { class: "secondary-page friends-page" },
    el("div", { class: "page-heading" }, el("h1", {}, t("Friends", "Freunde"))),
    el("fieldset", { class: "friend-views" },
      el("legend", { class: "sr-only" }, t("Friends view", "Freunde-Ansicht")),
      views.map(([value, label], index) => el("label", {},
        el("input", { type: "radio", name: "friend-view", value,
          checked: index === (initial.people?.some(person => person.relationship === "incoming") ? 1 : 0), class: "sr-only" }),
        el("span", {}, label)))),
    el("div", { class: "secondary-panels friend-panels" },
      el("section", { class: "panel people-panel friend-search" },
        el("h2", {}, t("Find friends", "Freunde suchen")),
        form(field(t("Search term", "Suchbegriff"), input), t("Search", "Suchen"), async () => {
          query = input.value.trim();
          if (!query) {
            results.hidden = true;
            resultList.replaceChildren();
            return;
          }
          const data = await api("people?query=" + encodeURIComponent(query), { signal });
          updateResults(data.people ?? []);
        }),
        feedback,
        results),
      el("section", { class: "panel people-panel friend-list" }, el("h2", {}, t("Your friends", "Deine Freunde")), friendsList),
      el("section", { class: "panel people-panel friend-requests" }, el("h2", {}, t("Requests", "Anfragen")), requestsList)));
}

const inviteLabels = {
  used: ["Used", "Verwendet"],
  revoked: ["Revoked", "Widerrufen"],
  expired: ["Expired", "Abgelaufen"],
  active: ["Active", "Offen"],
};

function inviteState(invite) {
  if (invite.usedAt || invite.redeemedAt) return "used";
  if (invite.revokedAt) return "revoked";
  if (Date.parse(invite.expiresAt) <= Date.now()) return "expired";
  return "active";
}

function ownerApproval(initial, signal) {
  const heading = t("Owner security", "Sicherheit des Betreiberkontos");
  const required = t("Enter a current authenticator code to unlock owner actions.",
    "Gib einen aktuellen Authenticator-Code ein, um Betreiberaktionen freizugeben.");
  const summary = status();
  summary.tabIndex = -1;
  const code = el("input", {
    type: "text", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9]{6}", maxlength: "6", required: true,
  });
  let deadline = 0;
  let timer;
  let page;
  let confirmation;

  const authorization = form(field(t("Authenticator code", "Authenticator-Code"), code),
    t("Unlock owner actions", "Betreiberaktionen freigeben"), async () => {
      const value = code.value;
      code.value = "";
      const { approvedUntil } = await api("admin/authorize", { method: "POST", body: { code: value }, signal });
      signal.throwIfAborted();
      setApproval(approvedUntil);
      summary.focus({ preventScroll: true });
    });
  const node = el("section", { class: "panel people-panel" }, el("h2", {}, heading), summary, authorization);

  function approved() {
    return !signal.aborted && deadline > Date.now();
  }

  function update() {
    clearTimeout(timer);
    const unlocked = approved();
    authorization.hidden = unlocked;
    tell(summary, unlocked ? t("Owner actions unlocked until {time}.", "Betreiberaktionen sind bis {time} freigegeben.",
      { time: localizedTime(deadline) }) : required);
    for (const control of page.querySelectorAll("[data-owner-action]")) control.hidden = !unlocked;
    if (unlocked) timer = setTimeout(update, Math.min(deadline - Date.now(), 2 ** 31 - 1));
    else if (confirmation?.isConnected) {
      closeDialog();
      code.focus();
    }
  }

  function setApproval(until) {
    deadline = Number.isSafeInteger(until) ? until * 1000 : 0;
    update();
  }

  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    if (confirmation?.isConnected) closeDialog();
  }, { once: true });

  return {
    node,
    attach(root) {
      page = root;
      setApproval(initial);
    },
    protect(control) {
      control.dataset.ownerAction = "";
      control.hidden = !approved();
      return control;
    },
    confirm(title, content) {
      if (!approved()) {
        update();
        code.focus();
        return;
      }
      confirmation = content;
      showDialog(title, content);
    },
    async mutate(path, options) {
      signal.throwIfAborted();
      if (!approved()) {
        update();
        code.focus();
        throw new Error(required);
      }
      const current = deadline;
      try {
        return await api(path, { ...options, signal });
      } catch (error) {
        if (error.details?.code === "ROOMS_OWNER_APPROVAL" && current === deadline && !signal.aborted) {
          setApproval(0);
          code.focus();
        }
        throw error;
      }
    },
  };
}

function accountPanel(signal, approval) {
  const title = t("Accounts", "Konten");
  const list = peopleList(title);
  const feedback = status();
  let cursor;
  const more = button(t("Load more", "Mehr laden"), load);
  const node = el("section", { class: "panel people-panel", hidden: true }, el("h2", {}, title), list, feedback, more);

  function row(account) {
    function confirm(label, explanation, body) {
      const confirmation = form([
        el("p", {}, account.displayName + " · @" + account.username),
        el("p", { class: "muted" }, explanation),
        button(t("Cancel", "Abbrechen"), closeDialog, { class: "ghost" }),
      ], label, async () => {
        const { account: next } = await approval.mutate("admin/accounts/" + identifier(account.id), { method: "PATCH", body });
        if (signal.aborted) return;
        if (confirmation.isConnected) closeDialog();
        entry.replaceWith(row(next));
        notify(t("Account updated.", "Konto aktualisiert."));
      });
      approval.confirm(label, confirmation);
    }
    const disable = t("Suspend account", "Konto sperren");
    const enable = t("Reactivate", "Wieder freigeben");
    const revoke = t("End sessions", "Sitzungen beenden");
    const controls = account.admin ? [] : [
      button(account.disabled ? enable : disable, () => account.disabled
        ? confirm(enable, t("This lets the person sign in again.", "Die Person kann sich wieder anmelden."), { disabled: false })
        : confirm(disable, t("This blocks sign-in and ends all sessions and live broadcasts for this account.",
          "Das sperrt die Anmeldung und beendet alle Sitzungen und Übertragungen dieses Kontos."), { disabled: true }),
      { class: account.disabled ? "" : "danger" }),
      !account.disabled && button(revoke, () => confirm(revoke, t("This signs this person out everywhere and ends their broadcasts.",
        "Die Person wird überall abgemeldet, und ihre Übertragungen werden beendet."), { revokeSessions: true })),
    ];
    const detail = account.admin ? t("Site operator", "Betreiber") : account.disabled ? t("Suspended", "Gesperrt") : "";
    const entry = personRow(account, controls.filter(Boolean).map(approval.protect), detail);
    return entry;
  }

  async function load() {
    if (more.disabled || cursor === null) return;
    more.disabled = true;
    tell(feedback, "");
    try {
      const { accounts, next } = await api("admin/accounts" + (cursor ? "?after=" + encodeURIComponent(cursor) : ""), { signal });
      signal.throwIfAborted();
      list.append(...accounts.map(row));
      cursor = next ?? null;
      more.hidden = cursor === null;
    } catch (error) {
      if (!signal.aborted) tell(feedback, error.message, "error");
    } finally {
      more.disabled = false;
    }
  }

  return { node, initialize: () => { if (cursor === undefined) void load(); } };
}

export async function renderAdmin({ signal, onSecurity }) {
  const security = await api("admin/security", { signal });
  signal.throwIfAborted();
  if (security.configured !== true) {
    return el("div", { class: "secondary-page invitations-page" },
      el("div", { class: "page-heading" }, el("h1", {}, t("Site administration", "Website-Verwaltung"))),
      el("section", { class: "panel people-panel" },
        el("h2", {}, t("Set up owner two-factor sign-in", "Zwei-Faktor-Anmeldung für das Betreiberkonto einrichten")),
        el("p", { class: "muted" }, t("Scan a QR code with your authenticator app to unlock owner actions.",
          "Scanne einen QR-Code mit deiner Authenticator-App, um Betreiberaktionen freizugeben.")),
        button(t("Set up with QR code", "Per QR-Code einrichten"), onSecurity, { class: "primary" })));
  }
  const initial = await api("admin/invites", { signal });
  signal.throwIfAborted();
  const approval = ownerApproval(security.approvedUntil, signal);
  const invites = peopleList(t("Created invites", "Erstellte Einladungen"));
  const invitationPanel = el("div", { class: "stack", hidden: true });
  const expiry = select([
    ["1", t("1 hour", "1 Stunde")], ["24", t("24 hours", "24 Stunden")],
    ["72", t("3 days", "3 Tage")], ["168", t("7 days", "7 Tage")],
  ], "24");
  const expires = invite => t("Expires {date}", "Gültig bis {date}", { date: localizedTime(invite.expiresAt) });

  async function updateList() {
    const fresh = await api("admin/invites", { signal });
    populate(fresh.invites ?? []);
  }

  function populate(entries) {
    invites.replaceChildren(...(entries.length ? entries.map(invite => {
      const state = inviteState(invite);
      const details = el("div", {},
        el("strong", {}, t(...inviteLabels[state])),
        el("p", { class: "subtle" }, expires(invite)));
      const revoke = state === "active" ? button(t("Revoke", "Widerrufen"), async event => {
        const trigger = event.currentTarget;
        trigger.disabled = true;
        try {
          await approval.mutate("admin/invites/" + identifier(invite.id), { method: "DELETE" });
          await updateList();
          notify(t("Invite revoked.", "Einladung widerrufen."));
        } catch (error) {
          if (!signal.aborted) notify(error.message);
        } finally {
          trigger.disabled = false;
        }
      }, { class: "danger" }) : null;
      return el("li", { class: "person-row" }, el("span", { class: "avatar", "aria-hidden": "true" }, "↗"), details,
        revoke && approval.protect(el("div", { class: "inline" }, revoke)));
    }) : [el("li", { class: "muted" }, t("No invites yet.", "Es gibt noch keine Einladungen."))]));
    invites.tabIndex = entries.length ? 0 : -1;
  }

  populate(initial.invites ?? []);
  const accounts = accountPanel(signal, approval);
  const invitationView = el("div", { class: "secondary-panels invite-panels" },
      el("section", { class: "panel people-panel invite-create" },
        el("h2", {}, t("New invite link", "Neuer Einladungslink")),
        el("p", { class: "muted" }, t("Each link creates one account and expires automatically.", "Jeder Link erlaubt genau eine Kontoerstellung und läuft automatisch ab.")),
        approval.protect(form(field(t("Valid for", "Gültigkeit"), expiry), t("Create link", "Link erstellen"), async () => {
          const response = await approval.mutate("admin/invites", { method: "POST", body: { hours: Number(expiry.value) } });
          signal.throwIfAborted();
          const invite = response.invite ?? response;
          const url = new URL(invite.url, location.origin);
          if (url.origin !== location.origin || !url.hash.startsWith("#invite=")) {
            throw new Error(t("The server returned an invalid invite link.", "Der Server hat keinen gültigen Einladungslink geliefert."));
          }
          const input = el("input", { type: "url", readonly: true, value: url.href, "aria-label": t("New invite link", "Neuer Einladungslink") });
          invitationPanel.replaceChildren(
            input,
            el("div", { class: "inline" }, button(t("Copy link", "Link kopieren"), () => copyField(input), { class: "primary" }),
              el("span", { class: "subtle" }, expires(invite))));
          invitationPanel.hidden = false;
          await updateList();
        })),
        invitationPanel),
      el("section", { class: "panel people-panel invite-list" }, el("h2", {}, t("Created invites", "Erstellte Einladungen")), invites));
  const title = el("h1", {}, t("Invites", "Einladungen"));
  const inviteButton = button(t("Invites", "Einladungen"), () => switchView(false), { "aria-pressed": "true" });
  const accountButton = button(t("Accounts", "Konten"), () => switchView(true), { "aria-pressed": "false" });
  function switchView(showAccounts) {
    title.textContent = showAccounts ? accountButton.textContent : inviteButton.textContent;
    invitationView.hidden = showAccounts;
    accounts.node.hidden = !showAccounts;
    inviteButton.setAttribute("aria-pressed", String(!showAccounts));
    accountButton.setAttribute("aria-pressed", String(showAccounts));
    if (showAccounts) accounts.initialize();
  }
  const page = el("div", { class: "secondary-page invitations-page" },
    el("div", { class: "stack" },
      el("div", { class: "page-heading" }, title, el("div", { class: "inline", role: "group", "aria-label": t("Site administration", "Website-Verwaltung") }, inviteButton, accountButton)),
      approval.node),
    invitationView, accounts.node);
  approval.attach(page);
  return page;
}
