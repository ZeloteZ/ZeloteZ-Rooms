import { t } from "./i18n.js";
import { api, button, copyField, el, field, form, identifier, localizedTime, notify, personRow, select, status, tell } from "./ui.js";

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
      controls = [action(person, "remove", t("Remove", "Entfernen"), "danger")];
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
        el("input", { type: "radio", name: "friend-view", value, checked: index === 0, class: "sr-only" }),
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

export async function renderAdmin({ signal }) {
  const initial = await api("admin/invites", { signal });
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
          await api("admin/invites/" + identifier(invite.id), { method: "DELETE", signal });
          await updateList();
          notify(t("Invite revoked.", "Einladung widerrufen."));
        } catch (error) {
          if (!signal.aborted) notify(error.message);
        } finally {
          trigger.disabled = false;
        }
      }, { class: "danger" }) : null;
      return el("li", { class: "person-row" }, el("span", { class: "avatar", "aria-hidden": "true" }, "↗"), details, revoke && el("div", { class: "inline" }, revoke));
    }) : [el("li", { class: "muted" }, t("No invites yet.", "Es gibt noch keine Einladungen."))]));
    invites.tabIndex = entries.length ? 0 : -1;
  }

  populate(initial.invites ?? []);
  return el("div", { class: "secondary-page invitations-page" },
    el("div", { class: "page-heading" }, el("h1", {}, t("Invites", "Einladungen"))),
    el("div", { class: "secondary-panels invite-panels" },
      el("section", { class: "panel people-panel invite-create" },
        el("h2", {}, t("New invite link", "Neuer Einladungslink")),
        el("p", { class: "muted" }, t("Each link creates one account and expires automatically.", "Jeder Link erlaubt genau eine Kontoerstellung und läuft automatisch ab.")),
        form(field(t("Valid for", "Gültigkeit"), expiry), t("Create link", "Link erstellen"), async () => {
          const response = await api("admin/invites", { method: "POST", body: { hours: Number(expiry.value) }, signal });
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
        }),
        invitationPanel),
      el("section", { class: "panel people-panel invite-list" }, el("h2", {}, t("Created invites", "Erstellte Einladungen")), invites)));
}
