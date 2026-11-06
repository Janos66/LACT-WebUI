/** Users page (administrators only): accounts, roles and password resets. */

import { api } from "../api.js";
import { el } from "../dom.js";
import { state } from "../store.js";
import {
  badge,
  button,
  confirmDialog,
  emptyState,
  modal,
  section,
  selectControl,
  toast,
} from "../ui.js";

const ROLE_OPTIONS = [
  { value: "admin", label: "Administrator" },
  { value: "operator", label: "Operator (read-only)" },
];

export default {
  id: "users",
  title: "Users",
  icon: "server",
  adminOnly: true,

  async render(ctx) {
    const root = el("div", { class: "stack" });

    if (state.me?.role !== "admin") {
      root.append(emptyState("Only administrators can manage accounts.", "warning"));
      return { root };
    }

    const data = await api.users.list().catch((error) => ({ error: error.message }));

    if (data.error) {
      root.append(emptyState(data.error, "warning"));
      return { root };
    }

    const body = el("div", {});
    const table = el("table", { class: "table" },
      el("thead", {},
        el("tr", {},
          el("th", {}, "User"),
          el("th", {}, "Role"),
          el("th", {}, "Status"),
          el("th", { class: "num" }, "Actions"),
        ),
      ),
    );
    const tbody = el("tbody", {});
    table.append(tbody);

    for (const user of data.users) {
      const roleSelect = selectControl({
        options: ROLE_OPTIONS,
        value: user.role,
        onChange: async (role) => {
          try {
            await api.users.update(user.username, { role });
            toast(`${user.username} is now ${role}`, "success");
            ctx.rerender();
          } catch (error) {
            toast(error.message, "error");
            ctx.rerender();
          }
        },
      });

      const actions = el("div", { class: "wrap", style: { justifyContent: "flex-end" } });

      actions.append(
        button("Password", {
          kind: "small",
          onClick: () => resetPassword(ctx, user.username),
        }),
        button(user.disabled ? "Enable" : "Disable", {
          kind: "small",
          onClick: async () => {
            try {
              await api.users.update(user.username, { disabled: !user.disabled });
              toast(
                `${user.username} ${user.disabled ? "enabled" : "disabled"}`,
                "success",
              );
              ctx.rerender();
            } catch (error) {
              toast(error.message, "error");
            }
          },
        }),
        button("", {
          kind: "small flat icon-only",
          iconName: "trash",
          title: `Delete ${user.username}`,
          onClick: async () => {
            const ok = await confirmDialog({
              title: `Delete ${user.username}?`,
              message: "The account is removed and every active session for it is terminated.",
              confirmLabel: "Delete",
              destructive: true,
            });
            if (!ok) return;

            try {
              await api.users.remove(user.username);
              toast(`${user.username} deleted`, "success");
              ctx.rerender();
            } catch (error) {
              toast(error.message, "error");
            }
          },
        }),
      );

      tbody.append(
        el("tr", {},
          el("td", {},
            el("div", {}, user.username),
            user.you ? el("div", { class: "hint" }, "this is you") : null,
          ),
          el("td", {}, roleSelect),
          el("td", {},
            user.disabled ? badge("disabled", "warn") : badge("active", "ok"),
          ),
          el("td", { class: "num" }, actions),
        ),
      );
    }

    body.append(el("div", { class: "table-wrap" }, table));

    root.append(
      section(`Accounts (${data.users.length})`, {
        actions: [
          button("Add user", {
            kind: "small suggested",
            iconName: "plus",
            onClick: () => addUser(ctx),
          }),
        ],
        note:
          "Administrators can change GPU settings, manage accounts and detach devices. " +
          "Operators can only monitor — the server rejects every write from their sessions.",
        body,
      }).root,
    );

    root.append(
      section("Sessions", {
        body: el("div", {},
          el("div", { class: "row" },
            el("div", { class: "row-label" },
              el("span", { class: "row-title" }, "Your session"),
              el("span", { class: "row-subtitle" },
                `${state.me?.username ?? "?"} · ${state.me?.role ?? "?"}`),
            ),
            el("div", { class: "row-control" },
              button("Change password", { kind: "small", onClick: () => changePassword(ctx) }),
            ),
          ),
        ),
      }).root,
    );

    return { root };
  },
};

function addUser(ctx) {
  const username = el("input", { type: "text", placeholder: "e.g. workshop", style: { width: "100%" } });
  const password = el("input", { type: "password", placeholder: "at least 8 characters", style: { width: "100%" } });
  const role = selectControl({ options: ROLE_OPTIONS, value: "operator", onChange: () => {} });

  modal({
    title: "Add user",
    body: el("div", { class: "stack" },
      el("label", { class: "field" }, el("span", {}, "Username"), username),
      el("label", { class: "field" }, el("span", {}, "Password"), password),
      el("label", { class: "field" }, el("span", {}, "Role"), role),
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Create",
        kind: "suggested",
        onClick: async () => {
          try {
            await api.users.create(username.value.trim(), password.value, role.value);
            toast(`User ${username.value.trim()} created`, "success");
            ctx.rerender();
          } catch (error) {
            toast(error.message, "error");
          }
        },
      },
    ],
  });
}

function resetPassword(ctx, username) {
  const password = el("input", { type: "password", placeholder: "new password", style: { width: "100%" } });

  modal({
    title: `Reset password for ${username}`,
    body: el("div", { class: "stack" },
      el("div", {}, "Every active session of this account will be signed out."),
      el("label", { class: "field" }, el("span", {}, "New password"), password),
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Set password",
        kind: "suggested",
        onClick: async () => {
          try {
            await api.users.update(username, { password: password.value });
            toast("Password updated", "success");
          } catch (error) {
            toast(error.message, "error");
          }
        },
      },
    ],
  });

  void ctx;
}

export function changePasswordDialog() {
  const current = el("input", { type: "password", style: { width: "100%" } });
  const next = el("input", { type: "password", style: { width: "100%" } });

  modal({
    title: "Change your password",
    body: el("div", { class: "stack" },
      el("label", { class: "field" }, el("span", {}, "Current password"), current),
      el("label", { class: "field" }, el("span", {}, "New password"), next),
      el("div", { class: "hint" }, "Other sessions of your account are signed out."),
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Change",
        kind: "suggested",
        onClick: async () => {
          try {
            await api.changePassword(current.value, next.value);
            toast("Password changed", "success");
          } catch (error) {
            toast(error.message, "error");
          }
        },
      },
    ],
  });
}

void changePasswordDialog;
