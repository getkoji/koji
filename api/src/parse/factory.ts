/**
 * ParseProvider factory — pick a backend from env.
 *
 * `docker` is the OSS default (talks to the sidecar `koji-parse`
 * container). Platform adds a `modal` backend in platform-60.
 */

import type { ParseProvider } from "./provider";
import { DockerParseProvider } from "./docker";

export function createParseProvider(): ParseProvider {
  const backend = process.env.KOJI_PARSE_BACKEND ?? "docker";
  switch (backend) {
    case "docker":
      return new DockerParseProvider();
    // "modal" backend added in platform-60
    default:
      throw new Error(`Unknown KOJI_PARSE_BACKEND: ${backend}`);
  }
}
