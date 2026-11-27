import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  pageInfo,
} from "../asc/client.ts";
import {
  appIdSchema,
  cursorSchema,
  idSchema,
  limitSchema,
} from "../schemas/common.ts";
import {
  AscApiError,
  InvalidInputError,
  PermissionError,
} from "../utils/errors.ts";

export const USER_ROLES = [
  "ADMIN",
  "FINANCE",
  "ACCOUNT_HOLDER",
  "SALES",
  "MARKETING",
  "APP_MANAGER",
  "DEVELOPER",
  "ACCESS_TO_REPORTS",
  "CUSTOMER_SUPPORT",
  "CREATE_APPS",
  "CLOUD_MANAGED_DEVELOPER_ID",
  "CLOUD_MANAGED_APP_DISTRIBUTION",
  "GENERATE_INDIVIDUAL_KEYS",
] as const;

/** Roles an invitation or `users set` may give; the Account Holder role cannot be given. */
const ASSIGNABLE_ROLES = USER_ROLES.filter((role) => role !== "ACCOUNT_HOLDER");

const ROLE_HINT =
  "App Store Connect refused this request: managing users and invitations needs a team API key (one with an issuer ID) with the Admin role.";

/** Runs a users request, naming the key it needs when Apple answers 403. */
async function withRoleHint<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof AscApiError && error.status === 403) {
      throw new PermissionError(ROLE_HINT, { cause: error });
    }
    throw error;
  }
}

const roleList = z.array(z.enum(USER_ROLES)).min(1).optional();
const assignableRoles = z
  .array(z.enum(ASSIGNABLE_ROLES as [string, ...string[]]))
  .min(1);
const appList = z.array(appIdSchema).max(200).default([]);

interface PersonAttributes {
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  roles?: string[];
  allAppsVisible?: boolean;
  provisioningAllowed?: boolean;
  expirationDate?: string;
}

const APP_FIELDS = ["name", "bundleId"];

/** The visible apps included with a user or invitation, by id, name and bundle ID. */
function visibleApps(
  document: Pick<AscDocument<unknown>, "included">,
  resource: AscResource<PersonAttributes>,
) {
  const relationship = resource.relationships?.visibleApps as
    | { data?: { type: string; id: string }[] }
    | undefined;
  return (relationship?.data ?? []).map(({ id }) => {
    const app = document.included?.find(
      (item) => item.type === "apps" && item.id === id,
    )?.attributes as { name?: string; bundleId?: string } | undefined;
    return { id, name: app?.name, bundleId: app?.bundleId };
  });
}

/**
 * A user or invitation as the commands print it. The email (a user's
 * username) is personal data, so it is left out unless asked for.
 */
function shapePerson(
  document: Pick<AscDocument<unknown>, "included">,
  resource: AscResource<PersonAttributes>,
  emails: boolean,
) {
  const attributes = resource.attributes ?? {};
  return {
    id: resource.id,
    firstName: attributes.firstName,
    lastName: attributes.lastName,
    ...(emails ? { email: attributes.username ?? attributes.email } : {}),
    roles: attributes.roles,
    allAppsVisible: attributes.allAppsVisible,
    provisioningAllowed: attributes.provisioningAllowed,
    ...(attributes.expirationDate
      ? { expirationDate: attributes.expirationDate }
      : {}),
    visibleApps: attributes.allAppsVisible
      ? "all"
      : visibleApps(document, resource),
  };
}

export const usersInput = z.object({
  roles: roleList,
  apps: z.array(appIdSchema).min(1).max(50).optional(),
  emails: z.boolean().default(false),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** Team members by last name, with roles and the apps they can see. */
export async function listUsers(
  client: AscClient,
  input: z.output<typeof usersInput>,
) {
  const response = await withRoleHint(() =>
    client.get<AscDocument<PersonAttributes>>("/v1/users", {
      "filter[roles]": input.roles,
      "filter[visibleApps]": input.apps,
      sort: "lastName",
      include: "visibleApps",
      "fields[users]": [
        ...(input.emails ? ["username"] : []),
        "firstName",
        "lastName",
        "roles",
        "allAppsVisible",
        "provisioningAllowed",
        "visibleApps",
      ],
      "fields[apps]": APP_FIELDS,
      "limit[visibleApps]": 50,
      limit: input.limit,
      cursor: input.cursor,
    }),
  );
  return {
    users: response.data.map((user) =>
      shapePerson(response, user, input.emails),
    ),
    ...pageInfo(response),
  };
}

export const invitationsInput = usersInput;

/** Pending invitations by last name, with roles, visible apps and when each expires. */
export async function listInvitations(
  client: AscClient,
  input: z.output<typeof invitationsInput>,
) {
  const response = await withRoleHint(() =>
    client.get<AscDocument<PersonAttributes>>("/v1/userInvitations", {
      "filter[roles]": input.roles,
      "filter[visibleApps]": input.apps,
      sort: "lastName",
      include: "visibleApps",
      "fields[userInvitations]": [
        ...(input.emails ? ["email"] : []),
        "firstName",
        "lastName",
        "expirationDate",
        "roles",
        "allAppsVisible",
        "provisioningAllowed",
        "visibleApps",
      ],
      "fields[apps]": APP_FIELDS,
      "limit[visibleApps]": 50,
      limit: input.limit,
      cursor: input.cursor,
    }),
  );
  return {
    invitations: response.data.map((invitation) =>
      shapePerson(response, invitation, input.emails),
    ),
    ...pageInfo(response),
  };
}

const nameSchema = (option: string) =>
  z
    .string({ error: `Give ${option}.` })
    .trim()
    .min(1)
    .max(100);

export const inviteInput = z.object({
  email: z.email({ error: "Give --email with the person's email address." }),
  firstName: nameSchema("--first-name"),
  lastName: nameSchema("--last-name"),
  roles: assignableRoles,
  apps: appList,
  provisioning: z.boolean().default(false),
  yes: z.boolean().default(false),
});

/**
 * Invites someone to the team. Without --app they see every app; with it,
 * only those. Without `yes`, only shows the invitation it would send.
 */
export async function inviteUser(
  client: AscClient,
  input: z.output<typeof inviteInput>,
) {
  const invitation = {
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    roles: input.roles,
    allAppsVisible: input.apps.length === 0,
    provisioningAllowed: input.provisioning,
    visibleApps: input.apps.length === 0 ? "all" : input.apps,
  };
  if (!input.yes) {
    return { dryRun: true, action: "invite", invitation };
  }
  const created = await withRoleHint(() =>
    client.post<{ data: AscResource<PersonAttributes> }>(
      "/v1/userInvitations",
      {
        data: {
          type: "userInvitations",
          attributes: {
            email: input.email,
            firstName: input.firstName,
            lastName: input.lastName,
            roles: input.roles,
            allAppsVisible: input.apps.length === 0,
            provisioningAllowed: input.provisioning,
          },
          ...(input.apps.length > 0
            ? {
                relationships: {
                  visibleApps: {
                    data: input.apps.map((id) => ({ type: "apps", id })),
                  },
                },
              }
            : {}),
        },
      },
    ),
  );
  return {
    dryRun: false,
    action: "invite",
    invitationId: created.data.id,
    expirationDate: created.data.attributes?.expirationDate,
  };
}

const userIdSchema = idSchema("users");

/** One user with roles and visible apps; the email is left out. */
async function readUser(client: AscClient, userId: string) {
  const document = await client.get<{
    data: AscResource<PersonAttributes>;
    included?: AscResource[];
  }>(`/v1/users/${userId}`, {
    include: "visibleApps",
    "fields[users]": [
      "firstName",
      "lastName",
      "roles",
      "allAppsVisible",
      "provisioningAllowed",
      "visibleApps",
    ],
    "fields[apps]": APP_FIELDS,
    "limit[visibleApps]": 50,
  });
  return shapePerson(document, document.data, false);
}

export const setUserInput = z
  .object({
    userId: userIdSchema,
    roles: assignableRoles.optional(),
    apps: appList,
    allApps: z.boolean().default(false),
    provisioning: z.boolean().optional(),
    yes: z.boolean().default(false),
  })
  .refine((input) => !(input.allApps && input.apps.length > 0), {
    message: "Give --app or --all-apps, not both.",
  })
  .refine(
    (input) =>
      input.roles !== undefined ||
      input.apps.length > 0 ||
      input.allApps ||
      input.provisioning !== undefined,
    {
      message:
        "Give what to change: --role, --app, --all-apps or --provisioning/--no-provisioning.",
    },
  );

/**
 * Changes a user's roles, visible apps or provisioning access. --role and
 * --app replace the current lists. Without `yes`, only shows the user and
 * the change.
 */
export async function setUser(
  client: AscClient,
  input: z.output<typeof setUserInput>,
) {
  return withRoleHint(async () => {
    const user = await readUser(client, input.userId);
    if (user.roles?.includes("ACCOUNT_HOLDER")) {
      throw new InvalidInputError(
        "This user is the Account Holder, whose access cannot be changed through the API. Nothing was changed.",
      );
    }
    const attributes: Record<string, unknown> = {};
    if (input.roles) attributes.roles = input.roles;
    if (input.allApps) attributes.allAppsVisible = true;
    if (input.apps.length > 0) attributes.allAppsVisible = false;
    if (input.provisioning !== undefined) {
      attributes.provisioningAllowed = input.provisioning;
    }
    const change = {
      ...attributes,
      ...(input.apps.length > 0 ? { visibleApps: input.apps } : {}),
    };
    if (!input.yes) {
      return { dryRun: true, action: "set", user, change };
    }
    await client.patch(`/v1/users/${input.userId}`, {
      data: {
        type: "users",
        id: input.userId,
        attributes,
        ...(input.apps.length > 0
          ? {
              relationships: {
                visibleApps: {
                  data: input.apps.map((id) => ({ type: "apps", id })),
                },
              },
            }
          : {}),
      },
    });
    return {
      dryRun: false,
      action: "set",
      user: await readUser(client, input.userId),
    };
  });
}

export const removeUserInput = z.object({
  userId: userIdSchema,
  yes: z.boolean().default(false),
});

/**
 * Removes a user from the team. This cannot be undone: they need a new
 * invitation to come back. Without `yes`, only shows the user.
 */
export async function removeUser(
  client: AscClient,
  input: z.output<typeof removeUserInput>,
) {
  return withRoleHint(async () => {
    const user = await readUser(client, input.userId);
    if (!input.yes) {
      return {
        dryRun: true,
        action: "remove",
        user,
        note: "Removing a user cannot be undone; they would need a new invitation.",
      };
    }
    await client.delete(`/v1/users/${input.userId}`);
    return { dryRun: false, action: "remove", userId: input.userId };
  });
}

export const cancelInvitationInput = z.object({
  invitationId: idSchema("users invitations"),
  yes: z.boolean().default(false),
});

/** Cancels a pending invitation, so its link stops working. Without `yes`, only shows it. */
export async function cancelInvitation(
  client: AscClient,
  input: z.output<typeof cancelInvitationInput>,
) {
  return withRoleHint(async () => {
    const document = await client.get<{
      data: AscResource<PersonAttributes>;
      included?: AscResource[];
    }>(`/v1/userInvitations/${input.invitationId}`, {
      include: "visibleApps",
      "fields[userInvitations]": [
        "firstName",
        "lastName",
        "expirationDate",
        "roles",
        "allAppsVisible",
        "provisioningAllowed",
        "visibleApps",
      ],
      "fields[apps]": APP_FIELDS,
      "limit[visibleApps]": 50,
    });
    const invitation = shapePerson(document, document.data, false);
    if (!input.yes) {
      return { dryRun: true, action: "cancel", invitation };
    }
    await client.delete(`/v1/userInvitations/${input.invitationId}`);
    return {
      dryRun: false,
      action: "cancel",
      invitationId: input.invitationId,
    };
  });
}
