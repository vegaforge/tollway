import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

/**
 * Layout props shared by every Fumadocs surface, so the brand wordmark and
 * the repository link stay consistent across the docs and any future layout.
 */
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: "Tollway",
    url: "/",
  },
  githubUrl: "https://github.com/vegaforge/tollway",
};
