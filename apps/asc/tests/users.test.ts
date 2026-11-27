import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { AscApiError } from "../src/utils/errors.ts";
import { mockClient, runCli } from "./team-harness.ts";

const user = {
  type: "users",
  id: "U1",
  attributes: {
    username: "pat@example.com",
    firstName: "Pat",
    lastName: "Lee",
    roles: ["DEVELOPER"],
    allAppsVisible: false,
    provisioningAllowed: false,
  },
  relationships: { visibleApps: { data: [{ type: "apps", id: "111" }] } },
};
const included = [
  {
    type: "apps",
    id: "111",
    attributes: { name: "One", bundleId: "com.example.one" },
  },
];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("users", () => {
  it("should list users with their apps and leave emails out", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({ data: [user], included })) as AscClient["get"],
    });
    const result = await runCli(
      ["users", "--role", "DEVELOPER", "--app", "111"],
      asc,
    );
    expect(result.exitCode).toBe(0);
    const query = vi.mocked(asc.get).mock.calls[0]?.[1];
    expect(query).toMatchObject({
      "filter[roles]": ["DEVELOPER"],
      "filter[visibleApps]": ["111"],
    });
    expect(query?.["fields[users]"]).not.toContain("username");
    const output = JSON.parse(result.stdout);
    expect(output.users[0]).toEqual({
      id: "U1",
      firstName: "Pat",
      lastName: "Lee",
      roles: ["DEVELOPER"],
      allAppsVisible: false,
      provisioningAllowed: false,
      visibleApps: [{ id: "111", name: "One", bundleId: "com.example.one" }],
    });
    expect(result.stdout).not.toContain("pat@example.com");
  });

  it("should include emails with --emails", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({ data: [user], included })) as AscClient["get"],
    });
    const result = await runCli(["users", "--emails"], asc);
    expect(JSON.parse(result.stdout).users[0].email).toBe("pat@example.com");
  });

  it("should explain a 403 as needing an Admin team key", async () => {
    const asc = mockClient({
      get: vi.fn(async () => {
        throw new AscApiError(403, {});
      }) as AscClient["get"],
    });
    const result = await runCli(["users"], asc);
    expect(result.stderr).toContain("[permission]");
    expect(result.stderr).toContain("Admin role");
  });
});

describe("users invite", () => {
  const args = [
    "users",
    "invite",
    "--email",
    "sam@example.com",
    "--first-name",
    "Sam",
    "--last-name",
    "Tan",
    "--role",
    "APP_MANAGER",
    "--app",
    "111,222",
  ];

  it("should print the invitation without --yes", async () => {
    const asc = mockClient();
    const result = await runCli(args, asc);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      invitation: {
        roles: ["APP_MANAGER"],
        allAppsVisible: false,
        visibleApps: ["111", "222"],
      },
    });
    expect(asc.post).not.toHaveBeenCalled();
  });

  it("should send the invitation with --yes", async () => {
    const asc = mockClient({
      post: vi.fn(async () => ({
        data: {
          type: "userInvitations",
          id: "INV1",
          attributes: { expirationDate: "2026-12-27" },
        },
      })) as AscClient["post"],
    });
    const result = await runCli([...args, "--yes"], asc);
    expect(result.exitCode).toBe(0);
    expect(asc.post).toHaveBeenCalledWith("/v1/userInvitations", {
      data: {
        type: "userInvitations",
        attributes: {
          email: "sam@example.com",
          firstName: "Sam",
          lastName: "Tan",
          roles: ["APP_MANAGER"],
          allAppsVisible: false,
          provisioningAllowed: false,
        },
        relationships: {
          visibleApps: {
            data: [
              { type: "apps", id: "111" },
              { type: "apps", id: "222" },
            ],
          },
        },
      },
    });
    expect(JSON.parse(result.stdout).invitationId).toBe("INV1");
  });

  it("should refuse the Account Holder role and a missing email", async () => {
    const holder = await runCli(
      [
        "users",
        "invite",
        "--email",
        "a@example.com",
        "--first-name",
        "A",
        "--last-name",
        "B",
        "--role",
        "ACCOUNT_HOLDER",
      ],
      mockClient(),
    );
    expect(holder.stderr).toContain("[invalid_input]");
    const missing = await runCli(
      [
        "users",
        "invite",
        "--first-name",
        "A",
        "--last-name",
        "B",
        "--role",
        "ADMIN",
      ],
      mockClient(),
    );
    expect(missing.stderr).toContain("--email");
  });
});

describe("users set", () => {
  it("should show the change without --yes and patch roles and apps with --yes", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({ data: user, included })) as AscClient["get"],
      patch: vi.fn(async () => ({ data: user })) as AscClient["patch"],
    });
    const dry = await runCli(
      ["users", "set", "U1", "--role", "APP_MANAGER", "--app", "222"],
      asc,
    );
    expect(JSON.parse(dry.stdout)).toMatchObject({
      dryRun: true,
      user: { id: "U1", roles: ["DEVELOPER"] },
      change: {
        roles: ["APP_MANAGER"],
        allAppsVisible: false,
        visibleApps: ["222"],
      },
    });
    expect(asc.patch).not.toHaveBeenCalled();

    await runCli(
      ["users", "set", "U1", "--role", "APP_MANAGER", "--app", "222", "--yes"],
      asc,
    );
    expect(asc.patch).toHaveBeenCalledWith("/v1/users/U1", {
      data: {
        type: "users",
        id: "U1",
        attributes: { roles: ["APP_MANAGER"], allAppsVisible: false },
        relationships: { visibleApps: { data: [{ type: "apps", id: "222" }] } },
      },
    });
  });

  it("should turn off provisioning and give all apps", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({ data: user, included })) as AscClient["get"],
      patch: vi.fn(async () => ({ data: user })) as AscClient["patch"],
    });
    await runCli(
      ["users", "set", "U1", "--all-apps", "--no-provisioning", "--yes"],
      asc,
    );
    expect(vi.mocked(asc.patch).mock.calls[0]?.[1]).toEqual({
      data: {
        type: "users",
        id: "U1",
        attributes: { allAppsVisible: true, provisioningAllowed: false },
      },
    });
  });

  it("should refuse nothing to change and the Account Holder", async () => {
    const none = await runCli(["users", "set", "U1"], mockClient());
    expect(none.stderr).toContain("Give what to change");
    const holder = mockClient({
      get: vi.fn(async () => ({
        data: {
          ...user,
          attributes: { ...user.attributes, roles: ["ACCOUNT_HOLDER"] },
        },
      })) as AscClient["get"],
    });
    const result = await runCli(
      ["users", "set", "U1", "--all-apps", "--yes"],
      holder,
    );
    expect(result.stderr).toContain("Account Holder");
    expect(holder.patch).not.toHaveBeenCalled();
  });
});

describe("users remove", () => {
  it("should say it cannot be undone without --yes and delete with --yes", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({ data: user, included })) as AscClient["get"],
      delete: vi.fn(async () => {}) as AscClient["delete"],
    });
    const dry = await runCli(["users", "remove", "U1"], asc);
    expect(JSON.parse(dry.stdout).note).toContain("cannot be undone");
    expect(dry.stdout).not.toContain("pat@example.com");
    expect(asc.delete).not.toHaveBeenCalled();
    await runCli(["users", "remove", "U1", "--yes"], asc);
    expect(asc.delete).toHaveBeenCalledWith("/v1/users/U1");
  });
});

describe("users invitations", () => {
  const invitation = {
    type: "userInvitations",
    id: "INV1",
    attributes: {
      email: "sam@example.com",
      firstName: "Sam",
      lastName: "Tan",
      roles: ["ADMIN"],
      allAppsVisible: true,
      expirationDate: "2026-12-27",
    },
  };

  it("should list invitations without emails", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({ data: [invitation] })) as AscClient["get"],
    });
    const result = await runCli(["users", "invitations", "--limit", "5"], asc);
    expect(vi.mocked(asc.get).mock.calls[0]?.[0]).toBe("/v1/userInvitations");
    expect(vi.mocked(asc.get).mock.calls[0]?.[1]).toMatchObject({ limit: 5 });
    expect(JSON.parse(result.stdout).invitations[0]).toMatchObject({
      id: "INV1",
      visibleApps: "all",
      expirationDate: "2026-12-27",
    });
    expect(result.stdout).not.toContain("sam@example.com");
  });

  it("should cancel an invitation only with --yes", async () => {
    const asc = mockClient({
      get: vi.fn(async () => ({ data: invitation })) as AscClient["get"],
      delete: vi.fn(async () => {}) as AscClient["delete"],
    });
    await runCli(["users", "invitations", "cancel", "INV1"], asc);
    expect(asc.delete).not.toHaveBeenCalled();
    await runCli(["users", "invitations", "cancel", "INV1", "--yes"], asc);
    expect(asc.delete).toHaveBeenCalledWith("/v1/userInvitations/INV1");
  });
});
