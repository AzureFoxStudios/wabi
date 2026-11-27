# Roles

**Status (2026-11-27):** the role list below is implemented. Artist, Developer, repository (Lore) roles and service roles are **not** yet folded into it; see "Not yet unified".

## The one role list

A server has one role list, shown under Admin, Roles:

1. **Staff ranks, fixed:** Owner, Admin, Moderator. A person has at most one. They are given in People and can never be self-picked. They live with the account (`highestRole`, the RBAC projection).
2. **Listed roles, the server's own:** for example "Strawberry Crew" or "Banana Jammers". Admins create, rename and remove them.

Rules:

- A person can hold **several** listed roles, alongside a staff rank.
- Each listed role says whether **members may pick it themselves** in Welcome. Roles that do not are given only by staff.
- Staff give or take any listed role in People.
- A room can **need a role**. Only holders see and use it. Moderators, admins and the owner can always open it. A room that moderators must not see uses the admin minimum rank instead (the owner can open everything).
- Signed-in members can see who holds which role (the profile card lists them). Guests cannot.

## Storage and endpoints

Listed roles were introduced as "community roles", and storage keeps that name so existing servers and older apps keep working. Only the wording changed.

- `server_center.json`: `communityRoles` (`id`, `name`, `description`, `selfAssignable`), `memberCommunityRoles` (user id to role ids), `channelCommunityRoles` (room id to the role it needs). A role stored without `selfAssignable` is self-pickable, as every role was before the field existed.
- `GET/PUT /api/server-center/community-roles` (admins): the list and the rooms. A PUT that omits `selfAssignable` for an existing role keeps the stored value.
- `PUT /api/server-center/reception/roles` (a member, for themselves): only self-pickable roles; roles staff gave are kept whatever the request says.
- `PUT /api/server-center/members/{userId}/roles` (admins): set a member's listed roles.
- `GET /api/server-center/role-holders` (signed-in members): the list and who holds what.

Room access is decided in `channel_access.rs` (`own_channel_role_allows`).

## Not yet unified

- **Artist and Developer** are still values of the single staff-rank slot. Giving one to an admin or moderator replaces that rank.
- **Repository (Lore) roles** and **service roles** are separate stores with their own editors.
- **Channel "who can open"** (member, moderator, admin minimum) is a separate control from "needs a role".
- Old reaction-role rules, where any exist, can still change a staff rank.
