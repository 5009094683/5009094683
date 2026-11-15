import type { Graph, TokenInfo } from '../transport/graph';
import { ANSWER_PERMISSION, MANAGE_PERMISSION } from '../transport/messenger';

/*
  From the token of a person who manages the Page to a token of the Page that
  does not expire: the kind the assistant runs on. Used after signing in with
  Facebook ("pnpm fb:connect") and for a person's token pasted into .env
  ("pnpm fb:check --save-page-token").
*/

/**
 * What is asked for when someone signs in. These four belong to every app
 * with Facebook's Messenger use case; asking for one that an app does not
 * have makes Facebook refuse the whole sign-in.
 */
export const PERMISSIONS = [
  // Read and answer the Page's chats.
  ANSWER_PERMISSION,
  // Switch the Page on for the app, and see that it stays on.
  MANAGE_PERMISSION,
  // The list of Pages the person manages, also where a business owns them.
  'pages_show_list',
  'business_management',
] as const;

export interface PageAccount {
  id: string;
  name: string;
  /** What this person may do on the Page. */
  tasks: string[];
  token: string;
}

export type PageTokenResult =
  | { ok: true; page: PageAccount; info: TokenInfo; pages: PageAccount[] }
  | { ok: false; problem: string; pages: PageAccount[] };

/** The Pages a person manages and has shared with the app. */
export async function pagesOf(
  graph: Graph,
  personToken: string,
  withTokens: boolean,
): Promise<PageAccount[]> {
  const listed = await graph.get<{ data?: Array<Record<string, unknown>> }>(
    'me/accounts',
    personToken,
    { fields: withTokens ? 'id,name,tasks,access_token' : 'id,name,tasks', limit: 100 },
  );
  return (listed.data ?? []).map((entry) => ({
    id: String(entry.id ?? ''),
    name: String(entry.name ?? ''),
    tasks: Array.isArray(entry.tasks) ? entry.tasks.map(String) : [],
    token: typeof entry.access_token === 'string' ? entry.access_token : '',
  }));
}

/**
 * Makes the lasting token of the Page. `wantedPageId` says which Page, where
 * the person manages several; '' takes the only one. Calls to Facebook that
 * fail are thrown as they are.
 */
export async function pageTokenOf(
  graph: Graph,
  personToken: string,
  wantedPageId: string,
): Promise<PageTokenResult> {
  // A token of the Page made from the long-lived token of the person does not expire.
  const lasting = await graph.extendToken(personToken);
  const pages = await pagesOf(graph, lasting, true);
  if (pages.length === 0) {
    return {
      ok: false,
      pages,
      problem:
        'This person manages no Page that the app was given access to. Sign in again and ' +
        'choose the Page when Facebook asks which ones to share.',
    };
  }
  const page =
    wantedPageId !== ''
      ? pages.find((candidate) => candidate.id === wantedPageId)
      : pages.length === 1
        ? pages[0]
        : undefined;
  if (!page) {
    return {
      ok: false,
      pages,
      problem:
        wantedPageId !== ''
          ? `None of the Pages has the id in FB_PAGE_ID (${wantedPageId}).`
          : 'Say which Page the assistant answers for: set FB_PAGE_ID in .env to its id.',
    };
  }
  if (!page.tasks.includes('MESSAGING') || !page.tasks.includes('MODERATE')) {
    return {
      ok: false,
      pages,
      problem:
        `On "${page.name}" this person may not answer messages. Someone with full access to ` +
        'the Page has to sign in.',
    };
  }
  const info = await graph.lookUpToken(page.token);
  const lacking = [ANSWER_PERMISSION, MANAGE_PERMISSION].filter(
    (name) => !info.permissions.includes(name),
  );
  if (lacking.length > 0) {
    return {
      ok: false,
      pages,
      problem:
        `Facebook did not grant ${lacking.join(' and ')}. Sign in again and leave every ` +
        'permission switched on when Facebook asks.',
    };
  }
  return { ok: true, page, info, pages };
}
