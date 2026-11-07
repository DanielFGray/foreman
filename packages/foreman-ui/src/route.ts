/** Client-side route of the page: the project list or one project's readings. */

export type Route =
  | { readonly _tag: "projects" }
  | { readonly _tag: "project"; readonly name: string };

/** Parses `pathname` into the page's route. Unknown paths fall back to the list. */
export const routeOf = (pathname: string): Route => {
  const match = /^\/p\/([^/]+)\/?$/.exec(pathname);
  if (match?.[1] !== undefined && match[1] !== "") {
    return { _tag: "project", name: decodeURIComponent(match[1]) };
  }
  return { _tag: "projects" };
};
