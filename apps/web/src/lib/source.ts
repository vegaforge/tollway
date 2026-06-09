import { loader } from "fumadocs-core/source";
import { docs } from "../../.source";

/**
 * Single entry point for everything that reads the MDX corpus: the page tree
 * (sidebar), slug lookup, and static-params generation. Fumadocs MDX compiles
 * the content (wired by withMDX in next.config); we feed the generated
 * collection into the loader.
 */
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
