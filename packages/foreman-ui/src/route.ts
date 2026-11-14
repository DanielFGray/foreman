/** Client-side route of the page: the dashboard, a project, or its task graph. */

export type Route =
  | { readonly _tag: "projects" }
  | { readonly _tag: "project"; readonly name: string }
  | { readonly _tag: "graph"; readonly name: string };

/** Parses `pathname` into the page's route. Unknown paths fall back to the dashboard. */
export const routeOf = (pathname: string): Route => {
  const match = /^\/p\/([^/]+)(\/graph)?\/?$/.exec(pathname);
  if (match?.[1] === undefined || match[1] === "") return { _tag: "projects" };
  const name = decodeURIComponent(match[1]);
  return match[2] === undefined ? { _tag: "project", name } : { _tag: "graph", name };
};

/** The path of a project's task graph. */
export const graphPath = (name: string): string => `/p/${encodeURIComponent(name)}/graph`;
