// The permission catalog. Global permissions come from a user's global roles;
// project permissions come from their role on that project.

export const GLOBAL_PERMISSIONS = {
  'admin.users': 'Create, edit and deactivate users, reset passwords and assign roles',
  'admin.roles': 'Create and edit roles and the permissions they grant',
  'admin.tokens': "Create and revoke any user's API tokens",
  'admin.audit': 'View the full audit log across the system',
  'projects.create': 'Create new projects',
  'projects.all': 'Full access to every project, as if Owner on each',
  'skills.publish': 'Publish Claude skills that every signed-in machine installs',
  'wiki.edit': 'Create and edit wiki pages and folders, upload files and restore old versions',
  'wiki.manage': 'Delete and restore wiki pages and folders, set folder access and moderate comments',
} as const;

export const PROJECT_PERMISSIONS = {
  'project.view': 'See the project, its boards, cards and updates',
  'project.manage': 'Edit project settings, members, boards, columns and areas',
  'project.import': 'Import or re-sync data from a spreadsheet',
  'project.audit': "View the project's activity history",
  'area.edit': "Edit an area's priority, expected date and notes",
  'card.create': 'Create cards',
  'card.edit': 'Edit card details',
  'card.move': 'Move cards between columns and reorder them',
  'card.archive': 'Archive and restore cards',
  'card.comment': 'Comment on cards',
  'attachment.upload': 'Upload attachments to cards',
  'attachment.delete': 'Delete attachments',
  'update.write': 'Write and edit progress updates',
  'request.create': 'Submit feature requests, vote and comment on them',
  'request.triage': 'Review, accept (turn into a card), decline or close feature requests',
  'wiki.write': "Create and edit pages in the project's wiki folder",
} as const;

export type GlobalPermission = keyof typeof GLOBAL_PERMISSIONS;
export type ProjectPermission = keyof typeof PROJECT_PERMISSIONS;

const allProject = Object.keys(PROJECT_PERMISSIONS) as ProjectPermission[];

export const BUILTIN_ROLES: { name: string; scope: 'global' | 'project'; description: string; permissions: string[] }[] = [
  {
    name: 'Administrator',
    scope: 'global',
    description: 'Full control of users, roles, tokens, audit history and every project.',
    permissions: Object.keys(GLOBAL_PERMISSIONS),
  },
  {
    name: 'Project Creator',
    scope: 'global',
    description: 'Can create new projects (and becomes their Owner).',
    permissions: ['projects.create'],
  },
  {
    name: 'Auditor',
    scope: 'global',
    description: 'Read-only access to the full audit log.',
    permissions: ['admin.audit'],
  },
  {
    name: 'Wiki Editor',
    scope: 'global',
    description: 'Create and edit wiki pages and folders.',
    permissions: ['wiki.edit'],
  },
  { name: 'Owner', scope: 'project', description: 'Everything on the project, including settings and members.', permissions: allProject },
  {
    name: 'Editor',
    scope: 'project',
    description: 'Create, edit, move and archive cards; write updates; see history.',
    permissions: allProject.filter((p) => p !== 'project.manage' && p !== 'project.import'),
  },
  {
    name: 'Contributor',
    scope: 'project',
    description: 'Create, edit and move cards and comment. Cannot archive or write updates.',
    permissions: ['project.view', 'project.audit', 'card.create', 'card.edit', 'card.move', 'card.comment', 'attachment.upload', 'request.create', 'wiki.write'],
  },
  {
    name: 'Requester',
    scope: 'project',
    description: 'Sees the project and submits, votes on and comments on feature requests. Cannot change the board.',
    permissions: ['project.view', 'request.create'],
  },
  { name: 'Viewer', scope: 'project', description: 'Read-only access to the project.', permissions: ['project.view', 'project.audit'] },
];

export function isKnownPermission(scope: 'global' | 'project', p: string) {
  return scope === 'global' ? p in GLOBAL_PERMISSIONS : p in PROJECT_PERMISSIONS;
}
